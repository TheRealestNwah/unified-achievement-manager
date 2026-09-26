import { pool } from "../db";
import { normalize, isTitleSubsequenceMatch } from "./normalize";
import { hasPlatformCollision } from "./platformCollision";

export interface GameMatchResult {
    groupsMerged: number;
    gamesRemoved: number;
    candidatesRecorded: number;
}

interface GameRow {
    id: string;
    title: string;
    platforms: string[];
    hasLegacySignal: boolean;
}

// Matches platforms.id in schema.sql - not the short "retro" name used
// elsewhere in comments/prose, which isn't the real stored value. Exported
// for legacySignalSplitDetector.ts, which needs the same legacy-signal check.
export const RETRO_PLATFORM_ID = "retroachievements";

// A platform link that's known to be an older-hardware-only release of a
// title, same risk category as RetroAchievements (see #225): a modern
// remake/remaster can legitimately share its exact title with one of these,
// so an exact-title cross-platform match involving one goes to human review
// rather than auto-merging. console_variant is set once per link and never
// overwritten (see canonicalStore.ts), so this reads what sync originally
// observed, not a live lookup.
//
// - psn: trophyTitlePlatform is a comma-joined list (see psn/client.ts) -
//   "PS3" alone or "PS3,PSVITA" is legacy-only, but "PS3,PS4" is a genuine
//   cross-gen release of the SAME game and must not trip this.
// - xbox: sync only ever sets this to the literal "Xbox 360" (see
//   xbox/sync.ts) when the modern achievements endpoint had nothing and the
//   legacy 360 endpoint did - already an unambiguous legacy-only signal.
// - steam: no generation concept - a Steam listing is never treated as legacy.
export function isLegacyOnlyLink(platformId: string, consoleVariant: string | null): boolean {
    if (!consoleVariant) return false;
    if (platformId === "xbox") return consoleVariant === "Xbox 360";
    if (platformId === "psn") {
        const variants = consoleVariant.split(",");
        return !variants.includes("PS4") && !variants.includes("PS5");
    }
    return false;
}

async function fetchGamesWithPlatforms(): Promise<GameRow[]> {
    const rows = await pool.query(`
        select
            g.id,
            g.title,
            array_agg(distinct gpl.platform_id) as platforms,
            array_agg(distinct gpl.platform_id || ':' || coalesce(gpl.console_variant, '')) as platform_variants
        from games g
        join game_platform_links gpl on gpl.game_id = g.id
        group by g.id, g.title
    `);
    return rows.rows.map((row) => ({
        id: row.id,
        title: row.title,
        platforms: row.platforms,
        hasLegacySignal:
            row.platforms.includes(RETRO_PLATFORM_ID) ||
            row.platform_variants.some((entry: string) => {
                const sep = entry.indexOf(":");
                const platformId = entry.slice(0, sep);
                const consoleVariant = entry.slice(sep + 1) || null;
                return isLegacyOnlyLink(platformId, consoleVariant);
            }),
    }));
}

// Cross-platform game matching, in two passes:
//
// 1. Exact match on normalized title (case, punctuation, trademark symbols
//    stripped) auto-merges, same as before - except when a platform link with
//    a legacy-generation signal (isLegacyOnlyLink above: RetroAchievements,
//    or a PSN/Xbox link known to be an older-hardware-only release) is
//    involved. Those only cover older/classic-system titles, so an
//    exact-title match that includes one carries a real, structural risk a
//    same-generation match doesn't: a modern remake or remaster sharing its
//    original's exact name (Resident Evil 2 1998 vs. the 2019 remake, both
//    just "Resident Evil 2" - see #73; RE4 2023 on Steam vs. an RE4 PS3
//    classic PSN trophy list, both "Resident Evil 4" - see #225). Those go to
//    the review queue instead, while any other exact-title platforms in the
//    same group still merge automatically as before. Exact-title groups that
//    contain multiple canonical games on one platform also go to review:
//    without release-year/product-id metadata, that duplicate listing is the
//    only safe signal that an exact title may represent different generations
//    (see #85).
// 2. A near-title-match pass across everything left (different normalized
//    titles) also goes to the review queue rather than either auto-merging
//    on a fuzzy match (risks merging genuinely different games - see
//    mergeGames' own comment below) or leaving it unmatched forever, which
//    is what happened before this existed (#76: "Grand Theft Auto V" vs.
//    "Grand Theft Auto V: Legacy", or a short colloquial title vs. the full
//    official name on another platform). Uses isTitleSubsequenceMatch
//    (see normalize.ts) rather than a word-overlap score - a plain shared-
//    word score can't tell "same title plus an appended suffix" from "same
//    franchise prefix, different sequel," and produced hundreds of
//    false-positive pairs (two unrelated sequels sharing just a number, or a
//    franchise's games sharing their first few words) when tried against
//    this app's real data.
export async function matchGames(): Promise<GameMatchResult> {
    const initialGames = await fetchGamesWithPlatforms();

    const groups = new Map<string, GameRow[]>();
    for (const game of initialGames) {
        const key = normalize(game.title);
        const list = groups.get(key) ?? [];
        list.push(game);
        groups.set(key, list);
    }

    let groupsMerged = 0;
    let gamesRemoved = 0;
    let candidatesRecorded = 0;

    for (const group of groups.values()) {
        if (group.length < 2) continue;

        // Two same-platform games sharing a title by coincidence aren't a
        // cross-platform match - only merge if multiple platforms are present.
        const platformsInGroup = new Set(group.flatMap((g) => g.platforms));
        if (platformsInGroup.size < 2) continue;

        // If one platform appears on more than one canonical game, the exact
        // title may be shared by different generations/releases (for example,
        // the 2007 and 2025 Skate games). We do not have release-year or
        // product-generation metadata that can distinguish that case from a
        // legitimate cross-generation merge, so require human review for every
        // pair in the exact-title group instead of silently over-merging it.
        if (hasPlatformCollision(group.map((game) => game.platforms))) {
            for (let i = 0; i < group.length; i++) {
                for (let j = i + 1; j < group.length; j++) {
                    const created = await recordGameCandidate(
                        group[i].id,
                        group[j].id,
                        0.99,
                        "exact-title-platform-collision",
                    );
                    if (created) candidatesRecorded++;
                }
            }
            continue;
        }

        const legacyGames = group.filter((g) => g.hasLegacySignal);
        const safeGames = group.filter((g) => !g.hasLegacySignal);

        let winner: GameRow;
        if (safeGames.length > 0) {
            winner = safeGames[0];
            for (const loser of safeGames.slice(1)) {
                // An exact title match isn't always the same game even
                // without a legacy platform involved - a human can already
                // have rejected this exact pair (e.g. a manually-discovered
                // case like #73's "skate." 2025 vs. Skate 2007, sharing an
                // exact title across Steam/PSN and a since-split-out Xbox
                // 360 entry). Without this check, the very next matching run
                // would just silently re-merge a pair someone already said
                // was wrong.
                if (await wasRejectedPair(winner.id, loser.id)) continue;
                await mergeGames(winner.id, loser.id);
                gamesRemoved++;
            }
            if (safeGames.length > 1) groupsMerged++;
        } else {
            winner = legacyGames[0];
        }

        // Everything else sharing this exact title with the (now-merged)
        // winner that has a legacy-generation signal: winner itself if it's
        // one of those. RetroAchievements games keep the older, more
        // specific reason string; other legacy-only platform links (see
        // isLegacyOnlyLink - #225, RE4 2023 Steam auto-merging with an RE4
        // PS3 classic PSN trophy list) get a new one.
        const legacyToReview = safeGames.length > 0 ? legacyGames : legacyGames.slice(1);
        for (const legacyGame of legacyToReview) {
            const reason = legacyGame.platforms.includes(RETRO_PLATFORM_ID)
                ? "exact-title-retro"
                : "exact-title-legacy-platform";
            const created = await recordGameCandidate(winner.id, legacyGame.id, 0.99, reason);
            if (created) candidatesRecorded++;
        }
    }

    // Re-fetch rather than reuse initialGames - the merges above changed
    // which game ids exist, and near-title matching should compare today's
    // canonical games, not a pre-merge snapshot.
    const currentGames = await fetchGamesWithPlatforms();
    for (let i = 0; i < currentGames.length; i++) {
        for (let j = i + 1; j < currentGames.length; j++) {
            const a = currentGames[i];
            const b = currentGames[j];
            if (normalize(a.title) === normalize(b.title)) continue; // handled above
            // Two games that are EACH single-platform on the same platform
            // (e.g. two separate PSN listings) are a same-platform title
            // collision, not a cross-platform candidate - skip those. But once
            // either side already spans multiple platforms, one shared
            // platform doesn't mean the same thing: each platform_game_id is
            // unique per canonical game (enforced by game_platform_links'
            // unique constraint), so a shared platform_id here is always two
            // distinct listings on it, not the same listing counted twice.
            // That's exactly what happened with Skyrim (#76): the PSN
            // Special Edition trophy list (bare-titled "Skyrim", grouped with
            // the PSN/Steam original by an earlier near-title match) could
            // never be suggested against "...Skyrim Special Edition" on
            // Steam/Xbox, because both groups happened to include Steam.
            if (a.platforms.length === 1 && b.platforms.length === 1 && a.platforms[0] === b.platforms[0]) continue;
            if (!isTitleSubsequenceMatch(a.title, b.title)) continue;

            const created = await recordGameCandidate(a.id, b.id, 0.75, "near-title-match");
            if (created) candidatesRecorded++;
        }
    }

    return { groupsMerged, gamesRemoved, candidatesRecorded };
}

async function wasRejectedPair(gameAId: string, gameBId: string): Promise<boolean> {
    const [first, second] = [gameAId, gameBId].sort();
    const result = await pool.query(
        "select 1 from game_merge_candidates where game_a_id = $1 and game_b_id = $2 and status = 'rejected'",
        [first, second]
    );
    return result.rows.length > 0;
}

// Idempotent: a pair already recorded (pending, confirmed, or rejected)
// isn't re-inserted, so a rejected suggestion doesn't keep coming back every
// time matching runs, and re-running doesn't spam duplicate pending rows.
// Always stores the pair with the lexicographically smaller id first so the
// unique constraint catches it regardless of which side was compared first.
async function recordGameCandidate(gameAId: string, gameBId: string, confidence: number, reason: string): Promise<boolean> {
    const [first, second] = [gameAId, gameBId].sort();
    const result = await pool.query(
        `insert into game_merge_candidates (game_a_id, game_b_id, confidence, reason)
         values ($1, $2, $3, $4)
         on conflict (game_a_id, game_b_id) do nothing
         returning id`,
        [first, second, confidence, reason]
    );
    return result.rows.length > 0;
}

// Exported for manual merges (matching/routes.ts) and for confirming a
// game_merge_candidate below - automatic matching above only merges on
// exact normalized title (minus the retro exception), which deliberately
// misses genuine same-game cases with differently formatted titles across
// platforms. A human confirming those, via the review queue or a manual
// "Link games" pairing, is safer than loosening the automatic match to
// fuzzy title comparison, which risks merging genuinely different games.
export async function mergeGames(winnerId: string, loserId: string): Promise<void> {
    // Defense in depth for the manual-merge route, which takes arbitrary ids
    // from a request body - the automatic path above never pairs a game with
    // itself, but a manual merge could if given the same id twice, and this
    // would otherwise fall through to deleting the row out from under itself.
    if (winnerId === loserId) return;

    const client = await pool.connect();
    try {
        await client.query("begin");
        await client.query("update game_platform_links set game_id = $1 where game_id = $2", [winnerId, loserId]);
        await client.query("update canonical_achievements set game_id = $1 where game_id = $2", [winnerId, loserId]);

        // Repoint ownership, but skip any row that would collide with an
        // owner the winner already has (same account can't own a game twice).
        await client.query(
            `update user_owned_games uog set game_id = $1
             where game_id = $2
               and not exists (
                   select 1 from user_owned_games x
                   where x.user_platform_account_id = uog.user_platform_account_id and x.game_id = $1
               )`,
            [winnerId, loserId]
        );
        await client.query("delete from user_owned_games where game_id = $1", [loserId]);

        // Repoint absence streaks the same way (see #58) - without this, the
        // games row's on-delete-cascade FK would just wipe the loser's
        // streak, silently resetting a genuinely-removed game's reconciliation
        // clock to zero any time a routine cross-platform match merges it.
        // On a collision (same account has a streak row for both games
        // already), keep the higher streak rather than either row's value.
        await client.query(
            `update game_absence_streaks winner
             set consecutive_missing_syncs = greatest(winner.consecutive_missing_syncs, loser.consecutive_missing_syncs)
             from game_absence_streaks loser
             where loser.game_id = $2
               and winner.game_id = $1
               and winner.user_platform_account_id = loser.user_platform_account_id`,
            [winnerId, loserId]
        );
        await client.query(
            `update game_absence_streaks gas set game_id = $1
             where game_id = $2
               and not exists (
                   select 1 from game_absence_streaks x
                   where x.user_platform_account_id = gas.user_platform_account_id and x.game_id = $1
               )`,
            [winnerId, loserId]
        );
        await client.query("delete from game_absence_streaks where game_id = $1", [loserId]);

        await client.query("delete from games where id = $1", [loserId]);
        await client.query("commit");
    } catch (err) {
        await client.query("rollback");
        throw err;
    } finally {
        client.release();
    }
}

// Manual review actions for game-merge candidates left by matchGames above -
// a human decides instead of an automatic merge. Mirrors
// achievementMatcher's confirmMatchCandidate/rejectMatchCandidate.
export async function confirmGameMergeCandidate(candidateId: string): Promise<void> {
    const candidate = await pool.query("select game_a_id, game_b_id from game_merge_candidates where id = $1", [
        candidateId,
    ]);
    if (!candidate.rows[0]) throw new Error("Game merge candidate not found");

    await mergeGames(candidate.rows[0].game_a_id, candidate.rows[0].game_b_id);
    await pool.query("update game_merge_candidates set status = 'confirmed', reviewed_at = now() where id = $1", [
        candidateId,
    ]);
}

export async function rejectGameMergeCandidate(candidateId: string): Promise<void> {
    await pool.query("update game_merge_candidates set status = 'rejected', reviewed_at = now() where id = $1", [
        candidateId,
    ]);
}
