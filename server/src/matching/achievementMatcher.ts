import { pool } from "../db";
import { normalize, wordOverlapScore } from "./normalize";
import { countStrippedNames, stripListTags } from "./achievementTags";
import { resolveTierFromRarity } from "../scoring/tier";
import { deleteIfUploaded } from "../games/uploads";

// A pending match whose two achievements are in different games (see #360) -
// left behind when a split moves one side to a new game. Confirming it would
// merge an achievement across games.
export const CROSS_GAME_PENDING_CANDIDATES = `
    select amc.id
    from achievement_match_candidates amc
    join achievement_platform_links apl on apl.id = amc.achievement_platform_link_id
    join canonical_achievements source on source.id = apl.canonical_achievement_id
    join canonical_achievements target on target.id = amc.candidate_canonical_achievement_id
    where amc.status = 'pending' and source.game_id <> target.game_id
`;

// A pending match whose target already has a different achievement from the
// source's own list (see #362). A list never holds the same achievement
// twice, so it can't be right, and confirming it would fuse the two.
export const SAME_LIST_PENDING_CANDIDATES = `
    select amc.id
    from achievement_match_candidates amc
    join achievement_platform_links source on source.id = amc.achievement_platform_link_id
    join achievement_platform_links other
      on other.canonical_achievement_id = amc.candidate_canonical_achievement_id
     and other.platform_id = source.platform_id and other.platform_game_id = source.platform_game_id
     and other.id <> source.id
    where amc.status = 'pending'
`;

const AUTO_MERGE_THRESHOLD = 1.0; // exact normalized name match, for now
const CANDIDATE_THRESHOLD = 0.5; // below this isn't worth recording as a maybe

interface AchievementRow {
    canonicalId: string;
    linkId: string;
    platformId: string;
    platformGameId: string;
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

// Each link's name with its platform list's per-game tag removed (see #357).
function strippedNamesByLink(achievements: AchievementRow[]): Map<string, string> {
    const byPlatform = new Map<string, AchievementRow[]>();
    for (const a of achievements) {
        if (!byPlatform.has(a.platformId)) byPlatform.set(a.platformId, []);
        byPlatform.get(a.platformId)!.push(a);
    }
    const stripped = new Map<string, string>();
    for (const rows of byPlatform.values()) {
        const names = stripListTags(rows.map((r) => r.name));
        rows.forEach((row, i) => stripped.set(row.linkId, names[i]));
    }
    return stripped;
}

async function getAchievements(gameId: string): Promise<AchievementRow[]> {
    const result = await pool.query(
        `select ca.id as canonical_id, apl.id as link_id, apl.platform_id, apl.platform_game_id, ca.name
         from canonical_achievements ca
         join achievement_platform_links apl on apl.canonical_achievement_id = ca.id
         where ca.game_id = $1`,
        [gameId]
    );
    return result.rows.map((r) => ({
        canonicalId: r.canonical_id,
        linkId: r.link_id,
        platformId: r.platform_id,
        platformGameId: r.platform_game_id,
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
    const proposed = new Set<string>();

    // Fold each platform's achievements into a running pool one at a time,
    // matching against whatever's accumulated from earlier platforms so far.
    for (let i = 1; i < platforms.length; i++) {
        const seenPlatforms = platforms.slice(0, i);
        const basePool = achievements.filter((a) => seenPlatforms.includes(a.platformId));
        const incoming = achievements.filter((a) => a.platformId === platforms[i]);
        const consumed = new Set<string>();
        const stripped = strippedNamesByLink(achievements);
        const baseNameCounts = countStrippedNames(basePool.map((a) => ({ key: a.canonicalId, stripped: stripped.get(a.linkId)! })));
        const incomingNameCounts = countStrippedNames(incoming.map((a) => ({ key: a.canonicalId, stripped: stripped.get(a.linkId)! })));
        const isUnique = (counts: Map<string, number>, name: string) => counts.get(normalize(name)) === 1;
        // A list never holds the same achievement twice, so a canonical
        // achievement that already has one from the incoming list is never a
        // match for another (see #362) - whichever order the rows come in.
        const listKey = (a: AchievementRow) => `${a.platformId}:${a.platformGameId}`;
        const listsByCanonical = new Map<string, Set<string>>();
        for (const a of achievements) {
            if (!listsByCanonical.has(a.canonicalId)) listsByCanonical.set(a.canonicalId, new Set());
            listsByCanonical.get(a.canonicalId)!.add(listKey(a));
        }

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
                if (listsByCanonical.get(base.canonicalId)!.has(listKey(candidate))) continue;
                const candidateRest = stripped.get(candidate.linkId)!;
                const baseRest = stripped.get(base.linkId)!;
                let score = wordOverlapScore(candidate.name, base.name);
                if (score < AUTO_MERGE_THRESHOLD) {
                    // Names that are the same once a per-game tag is removed
                    // (see #357) only count as exact when that name is
                    // unambiguous on both sides - a collection's games can
                    // share one. Otherwise the tagless score can still make
                    // it a likelier candidate, short of an auto-merge.
                    const exactWithoutTags =
                        normalize(candidateRest) === normalize(baseRest) &&
                        isUnique(incomingNameCounts, candidateRest) &&
                        isUnique(baseNameCounts, baseRest);
                    score = exactWithoutTags
                        ? AUTO_MERGE_THRESHOLD
                        : Math.max(score, Math.min(wordOverlapScore(candidateRest, baseRest), 0.99));
                }
                if (!best || score > best.score) best = { row: base, score };
            }

            if (best && best.score >= AUTO_MERGE_THRESHOLD) {
                await recordCandidate(candidate.linkId, best.row.canonicalId, best.score, "confirmed");
                await mergeAchievements(best.row.canonicalId, candidate.canonicalId);
                consumed.add(best.row.canonicalId);
                listsByCanonical.get(best.row.canonicalId)!.add(listKey(candidate));
                merged++;
            } else if (best && best.score >= CANDIDATE_THRESHOLD) {
                await recordCandidate(candidate.linkId, best.row.canonicalId, best.score, "pending");
                proposed.add(candidate.linkId);
            }
        }

        achievements = await getAchievements(gameId); // ids shift after merges
    }

    // An exact match later in the same pass can give a target the list an
    // earlier near-match came from, so sweep those out once merging is done.
    const dropped = await pool.query(
        `delete from achievement_match_candidates
         where id in (${SAME_LIST_PENDING_CANDIDATES})
           and candidate_canonical_achievement_id in (select id from canonical_achievements where game_id = $1)
         returning achievement_platform_link_id`,
        [gameId]
    );
    for (const row of dropped.rows) proposed.delete(row.achievement_platform_link_id);

    return { merged, candidates: proposed.size };
}

async function recordCandidate(
    achievementPlatformLinkId: string,
    candidateCanonicalAchievementId: string,
    confidence: number,
    status: "confirmed" | "pending"
): Promise<void> {
    // A pair already on record keeps its row (see #345): re-proposing it as
    // pending does nothing, so a rejected pair stays rejected and a pending
    // one isn't queued twice. Only an auto-merge upgrades it to confirmed.
    await pool.query(
        `insert into achievement_match_candidates
            (achievement_platform_link_id, candidate_canonical_achievement_id, confidence, status, reviewed_at)
         values ($1, $2, $3, $4, $5)
         on conflict (achievement_platform_link_id, candidate_canonical_achievement_id) do update
            set status = excluded.status, confidence = excluded.confidence, reviewed_at = excluded.reviewed_at
            where excluded.status = 'confirmed'`,
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
        // Repointing can't create a second row for a pair the winner already
        // has (see #345); the loser's copy of that pair is dropped instead.
        await client.query(
            `update achievement_match_candidates amc set candidate_canonical_achievement_id = $1
             where candidate_canonical_achievement_id = $2
               and not exists (
                   select 1 from achievement_match_candidates existing
                   where existing.achievement_platform_link_id = amc.achievement_platform_link_id
                     and existing.candidate_canonical_achievement_id = $1
               )`,
            [winnerId, loserId]
        );
        await client.query("delete from achievement_match_candidates where candidate_canonical_achievement_id = $1", [
            loserId,
        ]);

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

        // Carry each user's custom icon for the loser over to the winner (see
        // #342) - the on-delete-cascade FK would otherwise drop it silently.
        // Where the user already has one on the winner, that one stays.
        const droppedIcons = await client.query(
            `select loser.icon_url from user_achievement_icon_overrides loser
             where loser.canonical_achievement_id = $2
               and exists (
                   select 1 from user_achievement_icon_overrides x
                   where x.user_id = loser.user_id and x.canonical_achievement_id = $1
               )`,
            [winnerId, loserId]
        );
        await client.query(
            `insert into user_achievement_icon_overrides (user_id, canonical_achievement_id, icon_url)
             select user_id, $1, icon_url from user_achievement_icon_overrides where canonical_achievement_id = $2
             on conflict (user_id, canonical_achievement_id) do nothing`,
            [winnerId, loserId]
        );

        await client.query("delete from canonical_achievements where id = $1", [loserId]);
        await client.query("commit");
        // An uploaded icon that lost out to one already on the winner has
        // nothing pointing at it any more.
        for (const row of droppedIcons.rows) deleteIfUploaded(row.icon_url);
    } catch (err) {
        await client.query("rollback");
        throw err;
    } finally {
        client.release();
    }
}

// A candidate that can't be merged as proposed (see #406). It's the user's
// request that can't be done, not a server failure, so it answers 409.
export class MatchConflictError extends Error {
    readonly status = 409;
}

// Manual review actions for candidates left below AUTO_MERGE_THRESHOLD (see
// matchAchievementsForGame above) - a human decides instead of a score.
export async function confirmMatchCandidate(candidateId: string): Promise<void> {
    const candidate = await pool.query(
        "select achievement_platform_link_id, candidate_canonical_achievement_id from achievement_match_candidates where id = $1",
        [candidateId]
    );
    if (!candidate.rows[0]) throw Object.assign(new Error("Match candidate not found"), { status: 404 });

    const link = await pool.query("select canonical_achievement_id from achievement_platform_links where id = $1", [
        candidate.rows[0].achievement_platform_link_id,
    ]);
    const sourceId = link.rows[0].canonical_achievement_id;
    const targetId = candidate.rows[0].candidate_canonical_achievement_id;
    const games = await pool.query("select count(distinct game_id)::int as n from canonical_achievements where id = any($1)", [
        [sourceId, targetId],
    ]);
    if (games.rows[0].n > 1) throw new MatchConflictError("These achievements are in different games, so they can't be merged");
    const sameList = await pool.query(
        `select 1 from achievement_platform_links source
         join achievement_platform_links other
           on other.platform_id = source.platform_id and other.platform_game_id = source.platform_game_id
          and other.id <> source.id
         where source.id = $1 and other.canonical_achievement_id = $2
         limit 1`,
        [candidate.rows[0].achievement_platform_link_id, targetId]
    );
    if (sameList.rows.length > 0) {
        throw new MatchConflictError("That achievement already has a different one from the same list, so they can't be merged");
    }

    // mergeAchievements repoints any achievement_match_candidates row whose
    // candidate_canonical_achievement_id was the merge's loser - including
    // this one, if it turns out targetId loses to a PSN-native sourceId - so
    // this row's own candidate_canonical_achievement_id is already correct
    // by the time we get here regardless of which side won.
    await mergeAchievements(targetId, sourceId);

    // If the winner already had a row for this link, the merge kept that one
    // and dropped this one (see #345), so confirm by pair as well as by id.
    await pool.query(
        `update achievement_match_candidates set status = 'confirmed', reviewed_at = now()
         where id = $1
            or (achievement_platform_link_id = $2
                and candidate_canonical_achievement_id = (
                    select canonical_achievement_id from achievement_platform_links where id = $2
                ))`,
        [candidateId, candidate.rows[0].achievement_platform_link_id]
    );
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
): Promise<{ resolved: number; skipped: number; conflicted: number }> {
    let resolved = 0;
    let skipped = 0;
    // Ones that can't be merged as proposed stay pending for the user to
    // reject by hand, rather than one of them failing the whole batch.
    let conflicted = 0;
    for (const id of candidateIds) {
        const current = await pool.query(
            `select amc.status, apl.canonical_achievement_id as source_id, amc.candidate_canonical_achievement_id as target_id,
                    source.game_id <> target.game_id as cross_game
             from achievement_match_candidates amc
             join achievement_platform_links apl on apl.id = amc.achievement_platform_link_id
             join canonical_achievements source on source.id = apl.canonical_achievement_id
             join canonical_achievements target on target.id = amc.candidate_canonical_achievement_id
             where amc.id = $1`,
            [id]
        );
        const row = current.rows[0];
        if (!row || row.status !== "pending" || row.cross_game) {
            skipped++;
            continue;
        }
        if (action === "reject") await rejectMatchCandidate(id);
        else if (row.source_id === row.target_id) {
            await pool.query("update achievement_match_candidates set status = 'confirmed', reviewed_at = now() where id = $1", [id]);
        } else {
            try {
                await confirmMatchCandidate(id);
            } catch (err) {
                if (!(err instanceof MatchConflictError)) throw err;
                conflicted++;
                continue;
            }
        }
        resolved++;
    }
    return { resolved, skipped, conflicted };
}

export async function rejectMatchCandidate(candidateId: string): Promise<void> {
    await pool.query("update achievement_match_candidates set status = 'rejected', reviewed_at = now() where id = $1", [
        candidateId,
    ]);
}
