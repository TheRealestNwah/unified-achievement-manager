import { pool } from "../db";
import { wordOverlapScore } from "./normalize";
import { resolveTierFromRarity } from "../scoring/tier";

const AUTO_MERGE_THRESHOLD = 1.0; // exact normalized name match, for now
const CANDIDATE_THRESHOLD = 0.5; // below this isn't worth recording as a maybe

interface AchievementRow {
    canonicalId: string;
    linkId: string;
    platformId: string;
    name: string;
}

export interface AchievementMatchResult {
    gamesProcessed: number;
    achievementsMerged: number;
    candidatesRecorded: number;
}

// Runs after game matching, since achievements are only compared within a
// single (already-merged) game.
export async function matchAchievementsForAllGames(): Promise<AchievementMatchResult> {
    const games = await pool.query(`
        select ca.game_id
        from canonical_achievements ca
        join achievement_platform_links apl on apl.canonical_achievement_id = ca.id
        group by ca.game_id
        having count(distinct apl.platform_id) > 1
    `);

    let achievementsMerged = 0;
    let candidatesRecorded = 0;

    for (const row of games.rows) {
        const result = await matchAchievementsForGame(row.game_id);
        achievementsMerged += result.merged;
        candidatesRecorded += result.candidates;
    }

    return { gamesProcessed: games.rows.length, achievementsMerged, candidatesRecorded };
}

async function getAchievements(gameId: string): Promise<AchievementRow[]> {
    const result = await pool.query(
        `select ca.id as canonical_id, apl.id as link_id, apl.platform_id, ca.name
         from canonical_achievements ca
         join achievement_platform_links apl on apl.canonical_achievement_id = ca.id
         where ca.game_id = $1`,
        [gameId]
    );
    return result.rows.map((r) => ({
        canonicalId: r.canonical_id,
        linkId: r.link_id,
        platformId: r.platform_id,
        name: r.name,
    }));
}

// Exported for the manual game-merge route (matching/routes.ts) - a merge
// only needs to re-run matching for the one game just merged, not the whole
// library the way matchAchievementsForAllGames does.
export async function matchAchievementsForGame(gameId: string): Promise<{ merged: number; candidates: number }> {
    let achievements = await getAchievements(gameId);
    const platforms = [...new Set(achievements.map((a) => a.platformId))];

    let merged = 0;
    let candidates = 0;

    // Fold each platform's achievements into a running pool one at a time,
    // matching against whatever's accumulated from earlier platforms so far.
    for (let i = 1; i < platforms.length; i++) {
        const seenPlatforms = platforms.slice(0, i);
        const basePool = achievements.filter((a) => seenPlatforms.includes(a.platformId));
        const incoming = achievements.filter((a) => a.platformId === platforms[i]);
        const consumed = new Set<string>();

        for (const candidate of incoming) {
            // Already the same canonical achievement as something in the base
            // pool (e.g. two platforms merged in an earlier pass, and a third
            // platform's link was carried along by that merge's blanket
            // repoint). Nothing to do - scoring and "merging" it against
            // itself would call mergeAchievements(id, id), which deletes the
            // row via its own loser-cleanup step.
            if (basePool.some((base) => base.canonicalId === candidate.canonicalId)) {
                consumed.add(candidate.canonicalId);
                continue;
            }

            let best: { row: AchievementRow; score: number } | null = null;
            for (const base of basePool) {
                if (consumed.has(base.canonicalId)) continue;
                const score = wordOverlapScore(candidate.name, base.name);
                if (!best || score > best.score) best = { row: base, score };
            }

            if (best && best.score >= AUTO_MERGE_THRESHOLD) {
                await recordCandidate(candidate.linkId, best.row.canonicalId, best.score, "confirmed");
                await mergeAchievements(best.row.canonicalId, candidate.canonicalId);
                consumed.add(best.row.canonicalId);
                merged++;
            } else if (best && best.score >= CANDIDATE_THRESHOLD) {
                await recordCandidate(candidate.linkId, best.row.canonicalId, best.score, "pending");
                candidates++;
            }
        }

        achievements = await getAchievements(gameId); // ids shift after merges
    }

    return { merged, candidates };
}

async function recordCandidate(
    achievementPlatformLinkId: string,
    candidateCanonicalAchievementId: string,
    confidence: number,
    status: "confirmed" | "pending"
): Promise<void> {
    await pool.query(
        `insert into achievement_match_candidates
            (achievement_platform_link_id, candidate_canonical_achievement_id, confidence, status, reviewed_at)
         values ($1, $2, $3, $4, $5)`,
        [
            achievementPlatformLinkId,
            candidateCanonicalAchievementId,
            confidence,
            status,
            status === "confirmed" ? new Date() : null,
        ]
    );
}

export async function mergeAchievements(idA: string, idB: string): Promise<void> {
    // Defense in depth against the self-merge bug above: merging a row with
    // itself would fall through to deleting it, cascading away its platform
    // links and any recorded unlocks.
    if (idA === idB) return;

    const client = await pool.connect();
    try {
        await client.query("begin");

        // If either side is an authoritative PSN trophy, it always wins and
        // keeps its tier untouched - that's the whole point of PSN being the
        // scoring source of truth (see docs/data-model.md).
        const tierSources = await client.query("select id, tier_source from canonical_achievements where id in ($1, $2)", [
            idA,
            idB,
        ]);
        const psnRow = tierSources.rows.find((r) => r.tier_source === "psn_native");
        const winnerId = psnRow ? psnRow.id : idA;
        const loserId = winnerId === idA ? idB : idA;

        await client.query(
            "update achievement_platform_links set canonical_achievement_id = $1 where canonical_achievement_id = $2",
            [winnerId, loserId]
        );
        await client.query(
            "update achievement_match_candidates set candidate_canonical_achievement_id = $1 where candidate_canonical_achievement_id = $2",
            [winnerId, loserId]
        );

        if (!psnRow) {
            // No PSN tier involved - re-resolve from the rarest signal across
            // all now-merged platform copies of this achievement.
            const rarities = await client.query(
                "select global_unlock_rarity from achievement_platform_links where canonical_achievement_id = $1",
                [winnerId]
            );
            const values = rarities.rows
                .map((r) => r.global_unlock_rarity)
                .filter((v) => v != null)
                .map(Number);
            if (values.length > 0) {
                const { tier, points } = resolveTierFromRarity(Math.min(...values));
                await client.query("update canonical_achievements set tier = $1, points = $2 where id = $3", [
                    tier,
                    points,
                    winnerId,
                ]);
            }
        }

        await client.query("delete from canonical_achievements where id = $1", [loserId]);
        await client.query("commit");
    } catch (err) {
        await client.query("rollback");
        throw err;
    } finally {
        client.release();
    }
}

// Manual review actions for candidates left below AUTO_MERGE_THRESHOLD (see
// matchAchievementsForGame above) - a human decides instead of a score.
export async function confirmMatchCandidate(candidateId: string): Promise<void> {
    const candidate = await pool.query(
        "select achievement_platform_link_id, candidate_canonical_achievement_id from achievement_match_candidates where id = $1",
        [candidateId]
    );
    if (!candidate.rows[0]) throw new Error("Match candidate not found");

    const link = await pool.query("select canonical_achievement_id from achievement_platform_links where id = $1", [
        candidate.rows[0].achievement_platform_link_id,
    ]);
    const sourceId = link.rows[0].canonical_achievement_id;
    const targetId = candidate.rows[0].candidate_canonical_achievement_id;

    // mergeAchievements repoints any achievement_match_candidates row whose
    // candidate_canonical_achievement_id was the merge's loser - including
    // this one, if it turns out targetId loses to a PSN-native sourceId - so
    // this row's own candidate_canonical_achievement_id is already correct
    // by the time we get here regardless of which side won.
    await mergeAchievements(targetId, sourceId);

    await pool.query("update achievement_match_candidates set status = 'confirmed', reviewed_at = now() where id = $1", [
        candidateId,
    ]);
}

// Puts a rejected candidate back in the review queue - the undo for a
// "Different" click (see #252). Confirmed ones can't be reopened, since
// confirming already merged the two achievements.
export async function reopenMatchCandidate(candidateId: string): Promise<boolean> {
    const result = await pool.query(
        "update achievement_match_candidates set status = 'pending', reviewed_at = null where id = $1 and status = 'rejected'",
        [candidateId]
    );
    return (result.rowCount ?? 0) > 0;
}

// Confirms or rejects several candidates in one go (see #252), skipping any
// that are no longer pending - an earlier confirm in the same batch can
// already have merged a later candidate's two sides together.
export async function resolveMatchCandidates(
    candidateIds: string[],
    action: "confirm" | "reject"
): Promise<{ resolved: number; skipped: number }> {
    let resolved = 0;
    let skipped = 0;
    for (const id of candidateIds) {
        const current = await pool.query(
            `select amc.status, apl.canonical_achievement_id as source_id, amc.candidate_canonical_achievement_id as target_id
             from achievement_match_candidates amc
             join achievement_platform_links apl on apl.id = amc.achievement_platform_link_id
             where amc.id = $1`,
            [id]
        );
        const row = current.rows[0];
        if (!row || row.status !== "pending") {
            skipped++;
            continue;
        }
        if (action === "reject") await rejectMatchCandidate(id);
        else if (row.source_id === row.target_id) {
            await pool.query("update achievement_match_candidates set status = 'confirmed', reviewed_at = now() where id = $1", [id]);
        } else await confirmMatchCandidate(id);
        resolved++;
    }
    return { resolved, skipped };
}

export async function rejectMatchCandidate(candidateId: string): Promise<void> {
    await pool.query("update achievement_match_candidates set status = 'rejected', reviewed_at = now() where id = $1", [
        candidateId,
    ]);
}
