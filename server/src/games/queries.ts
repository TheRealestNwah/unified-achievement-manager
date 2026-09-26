import { pool } from "../db";
import { TIER_POINTS, qualifiesForCompletionPlatinum, GameCompletionCounts } from "../scoring/tier";

interface GamesQueryOptions {
    // Keep hidden (but not excluded) games - for totals, see #236.
    includeHidden?: boolean;
    // Just this one game, whatever its visibility - for its own page, see #237.
    gameId?: string;
}

export async function getGamesForUser(userId: string, { includeHidden = false, gameId }: GamesQueryOptions = {}) {
    const visibilityFilter = gameId
        ? "and g.id = $2"
        : `and not exists (
             select 1 from user_game_visibility ugv where ugv.user_id = $1 and ugv.game_id = g.id
             ${includeHidden ? "and ugv.mode = 'excluded'" : ""}
         )`;
    const result = await pool.query(
        `select
            g.id,
            g.title,
            (select mode from user_game_visibility where user_id = $1 and game_id = g.id) as visibility,
            -- A user's own pasted cover art (see #32) wins over the
            -- auto-detected one on games.cover_image_url.
            coalesce(
                (select cover_image_url from user_game_cover_overrides where user_id = $1 and game_id = g.id),
                g.cover_image_url
            ) as cover_image_url,
            -- Platforms this user actually owns the game on, not every
            -- platform with a game_platform_links row - catalog enrichment
            -- (steamCatalogEnrichment.ts, xboxCatalogEnrichment.ts) attaches
            -- a platform link purely to source real rarity data for a game
            -- the user owns elsewhere, without the user ever owning it on
            -- that platform. Scoping to user_owned_games (only ever written
            -- by recordOwnership, which real syncs call and enrichment never
            -- does) is what tells owned platforms apart from enrichment-only
            -- ones. See #78.
            (select array_agg(distinct upa.platform_id) from user_owned_games uog
                join user_platform_accounts upa on upa.id = uog.user_platform_account_id
                where upa.user_id = $1 and uog.game_id = g.id) as platforms,
            -- Display-only console-generation tags per platform link (e.g.
            -- {"psn": "PS5"}) - see #19. Only ever populated where the
            -- source platform's API gives clean per-title data. A platform
            -- can have more than one game_platform_links row for the same
            -- game (e.g. separate PS3 and PS4 trophy lists for a cross-gen
            -- title, correctly merged into one game by matchGames) - see
            -- #75, so this combines every distinct variant per platform
            -- rather than collapsing to whichever row jsonb_object_agg
            -- happens to keep on a duplicate key.
            -- Array of variants per platform (was a comma-joined string; see
            -- #193) so a merged game's linked entries render as one badge
            -- each (e.g. "psn (PS3)" and "psn (PS4)") instead of one combined
            -- "psn (PS3, PS4)" badge.
            (select jsonb_object_agg(platform_id, variants) from (
                select platform_id, jsonb_agg(distinct console_variant order by console_variant) as variants
                from game_platform_links
                where game_id = g.id and console_variant is not null
                group by platform_id
            ) grouped) as console_variants,
            count(ca.id) as total_achievements,
            count(uau.id) as unlocked_achievements,
            coalesce(sum(ca.points) filter (where uau.id is not null), 0) as points_earned,
            count(*) filter (where ca.tier = 'platinum' and uau.id is not null) as platinum_unlocked,
            count(*) filter (where ca.tier = 'gold' and uau.id is not null) as gold_unlocked,
            count(*) filter (where ca.tier = 'silver' and uau.id is not null) as silver_unlocked,
            count(*) filter (where ca.tier = 'bronze' and uau.id is not null) as bronze_unlocked
         from games g
         join canonical_achievements ca on ca.game_id = g.id
         left join achievement_platform_links apl on apl.canonical_achievement_id = ca.id
         left join user_achievement_unlocks uau
                on uau.achievement_platform_link_id = apl.id
               and uau.user_platform_account_id in (
                   select id from user_platform_accounts where user_id = $1
               )
         -- Ownership is a pure filter here, not a join source - see
         -- games/routes.ts history for why joining user_owned_games
         -- directly fanned every count out once per owning platform account.
         where exists (
             select 1 from user_owned_games uog
             join user_platform_accounts upa on upa.id = uog.user_platform_account_id
             where upa.user_id = $1 and uog.game_id = g.id
         )
         -- A game the user hid or excluded (see #192) is left out of the
         -- library view entirely, whichever mode. Totals (getFunStats) pass
         -- includeHidden, since a hidden game still counts toward the score
         -- and only an excluded one drops out (see #236). A single game's
         -- own page (gameId) shows it whatever its visibility (see #237).
         ${visibilityFilter}
         group by g.id, g.title, g.cover_image_url
         order by unlocked_achievements desc, g.title`,
        gameId ? [userId, gameId] : [userId]
    );
    return result.rows.map((rawRow) => {
        // node-postgres returns count()/sum() as strings; comparing those in
        // the dashboard is lexicographic ("9" < "10" is false), which dropped
        // games from In Progress (see #270). Hand back real numbers.
        const row = {
            ...rawRow,
            total_achievements: Number(rawRow.total_achievements),
            unlocked_achievements: Number(rawRow.unlocked_achievements),
            points_earned: Number(rawRow.points_earned),
            platinum_unlocked: Number(rawRow.platinum_unlocked),
            gold_unlocked: Number(rawRow.gold_unlocked),
            silver_unlocked: Number(rawRow.silver_unlocked),
            bronze_unlocked: Number(rawRow.bronze_unlocked),
        };
        const totalAchievements = row.total_achievements;
        const unlockedAchievements = row.unlocked_achievements;
        const realPlatinumUnlocked = row.platinum_unlocked;
        const isCompletionPlatinum = qualifiesForCompletionPlatinum({
            totalAchievements,
            unlockedAchievements,
            platinumUnlocked: realPlatinumUnlocked,
        });

        if (!isCompletionPlatinum) return { ...row, platinum_synthetic: false };

        // Synthetic completion platinum (see scoring/tier.ts, #145) - not a
        // real canonical_achievements row, so bump the counts/points the
        // frontend already renders for this game as if a real platinum had
        // been unlocked, matching the bonus recomputeUserScore adds to the
        // user's total (scoring/index.ts).
        return {
            ...row,
            platinum_unlocked: realPlatinumUnlocked + 1,
            points_earned: row.points_earned + TIER_POINTS.platinum,
            platinum_synthetic: true,
        };
    });
}

// Per-game achievement totals used to compute the synthetic completion-
// platinum bonus (scoring/tier.ts, #145) for scoring purposes. Deliberately
// a separate, lighter query rather than reusing getGamesForUser: scoring
// only needs these three counts per game, not cover art/console
// variants/tier breakdowns, and recomputeUserScore runs after every sync.
// Keep the join/group shape here in sync with getGamesForUser above if that
// one's ownership or unlock-scoping logic ever changes.
export async function getGameCompletionCountsForUser(userId: string): Promise<GameCompletionCounts[]> {
    const result = await pool.query(
        `select
            count(ca.id) as total_achievements,
            count(uau.id) as unlocked_achievements,
            count(*) filter (where ca.tier = 'platinum' and uau.id is not null) as platinum_unlocked
         from games g
         join canonical_achievements ca on ca.game_id = g.id
         left join achievement_platform_links apl on apl.canonical_achievement_id = ca.id
         left join user_achievement_unlocks uau
                on uau.achievement_platform_link_id = apl.id
               and uau.user_platform_account_id in (
                   select id from user_platform_accounts where user_id = $1
               )
         where exists (
             select 1 from user_owned_games uog
             join user_platform_accounts upa on upa.id = uog.user_platform_account_id
             where upa.user_id = $1 and uog.game_id = g.id
         )
         -- Only "excluded" games drop out of scoring (see #192) - a merely
         -- "hidden" game still counts toward the synthetic completion-
         -- platinum bonus here, matching its achievements still counting in
         -- recomputeUserScore's own points sum.
         and not exists (
             select 1 from user_game_visibility ugv
             where ugv.user_id = $1 and ugv.game_id = g.id and ugv.mode = 'excluded'
         )
         group by g.id`,
        [userId]
    );
    return result.rows.map((row) => ({
        totalAchievements: Number(row.total_achievements),
        unlockedAchievements: Number(row.unlocked_achievements),
        platinumUnlocked: Number(row.platinum_unlocked),
    }));
}

// Paged with limit/offset so the dashboard can show more than the latest 20
// (see #253).
export async function getRecentActivity(userId: string, limit = 20, offset = 0) {
    const result = await pool.query(
        `select
            ca.name, ca.tier, ca.points,
            -- Same override-first icon as getAchievementsForGame (see #32, #166).
            coalesce(
                (select icon_url from user_achievement_icon_overrides where user_id = $1 and canonical_achievement_id = ca.id),
                ca.icon_url
            ) as icon_url,
            g.id as game_id, g.title as game_title,
            apl.platform_id, uau.unlocked_at
         from user_achievement_unlocks uau
         join user_platform_accounts upa on upa.id = uau.user_platform_account_id
         join achievement_platform_links apl on apl.id = uau.achievement_platform_link_id
         join canonical_achievements ca on ca.id = apl.canonical_achievement_id
         join games g on g.id = ca.game_id
         where upa.user_id = $1
           -- Like the library list, the feed leaves out hidden and excluded
           -- games alike (see #236).
           and not exists (
               select 1 from user_game_visibility ugv where ugv.user_id = $1 and ugv.game_id = g.id
           )
         -- apl.id breaks ties so pages don't overlap or skip rows that
         -- share an unlock time.
         order by uau.unlocked_at desc, apl.id
         limit $2 offset $3`,
        [userId, limit, offset]
    );
    return result.rows;
}

// Novelty stats in the spirit of PSNProfiles/TrueAchievements "fun facts" -
// see #25. All read-only aggregates over data already tracked, no new
// sync/schema work.
// Excludes a known bad-data case, not the true earliest possible platform
// date: some legacy Xbox 360 unlocks come back from OpenXBL with a bogus
// sentinel timestamp (seen: 1752-12-31, centuries before Xbox existed, and
// shared identically across 87 unlocks - enough to fake out "busiest day"
// stats too) instead of a real unlock time - see #41 for the root cause.
// 2000-01-01 predates every platform's first real achievement by years, so
// it only ever excludes garbage, never a real early unlock.
const UNLOCK_TIMESTAMP_FLOOR = "2000-01-01";

// An excluded game (see #192) is removed from the score, so it's removed from
// every stat too; a merely hidden one still counts (see #236).
function notExcluded(gameIdColumn: string): string {
    return `not exists (
        select 1 from user_game_visibility ugv
        where ugv.user_id = $1 and ugv.game_id = ${gameIdColumn} and ugv.mode = 'excluded'
    )`;
}

export async function getFunStats(userId: string) {
    const rarest = await pool.query(
        `select ca.name, g.id as game_id, g.title as game_title, apl.platform_id, apl.global_unlock_rarity
         from user_achievement_unlocks uau
         join user_platform_accounts upa on upa.id = uau.user_platform_account_id
         join achievement_platform_links apl on apl.id = uau.achievement_platform_link_id
         join canonical_achievements ca on ca.id = apl.canonical_achievement_id
         join games g on g.id = ca.game_id
         where upa.user_id = $1 and apl.global_unlock_rarity is not null and ${notExcluded("g.id")}
         order by apl.global_unlock_rarity asc
         limit 1`,
        [userId]
    );

    const busiestPointsDay = await pool.query(
        `select date(uau.unlocked_at) as day, sum(ca.points) as points
         from user_achievement_unlocks uau
         join user_platform_accounts upa on upa.id = uau.user_platform_account_id
         join achievement_platform_links apl on apl.id = uau.achievement_platform_link_id
         join canonical_achievements ca on ca.id = apl.canonical_achievement_id
         where upa.user_id = $1 and uau.unlocked_at > $2 and ${notExcluded("ca.game_id")}
         group by day
         order by points desc
         limit 1`,
        [userId, UNLOCK_TIMESTAMP_FLOOR]
    );

    const busiestUnlockDay = await pool.query(
        `select date(uau.unlocked_at) as day, count(*) as unlocks
         from user_achievement_unlocks uau
         join user_platform_accounts upa on upa.id = uau.user_platform_account_id
         join achievement_platform_links apl on apl.id = uau.achievement_platform_link_id
         join canonical_achievements ca on ca.id = apl.canonical_achievement_id
         where upa.user_id = $1 and uau.unlocked_at > $2 and ${notExcluded("ca.game_id")}
         group by day
         order by unlocks desc
         limit 1`,
        [userId, UNLOCK_TIMESTAMP_FLOOR]
    );

    const oldest = await pool.query(
        `select ca.name, g.id as game_id, g.title as game_title, apl.platform_id, uau.unlocked_at
         from user_achievement_unlocks uau
         join user_platform_accounts upa on upa.id = uau.user_platform_account_id
         join achievement_platform_links apl on apl.id = uau.achievement_platform_link_id
         join canonical_achievements ca on ca.id = apl.canonical_achievement_id
         join games g on g.id = ca.game_id
         where upa.user_id = $1 and uau.unlocked_at > $2 and ${notExcluded("g.id")}
         order by uau.unlocked_at asc
         limit 1`,
        [userId, UNLOCK_TIMESTAMP_FLOOR]
    );

    // Real platinums only (a genuine psn_native canonical_achievements row,
    // or one matched in from PSN) - counted per unlock row, so the same
    // trophy earned separately on two linked platforms counts twice here,
    // matching recomputeUserScore's own per-platform accounting
    // (scoring/index.ts). Synthetic completion platinums (#145) aren't rows
    // in this table at all - see getGamesForUser's platinum_synthetic flag,
    // folded into totalPlatinums below instead.
    const platinums = await pool.query(
        `select uau.unlocked_at
         from user_achievement_unlocks uau
         join user_platform_accounts upa on upa.id = uau.user_platform_account_id
         join achievement_platform_links apl on apl.id = uau.achievement_platform_link_id
         join canonical_achievements ca on ca.id = apl.canonical_achievement_id
         where upa.user_id = $1 and ca.tier = 'platinum' and ${notExcluded("ca.game_id")}
         order by uau.unlocked_at asc`,
        [userId]
    );
    let longestPlatinumGapDays: number | null = null;
    for (let i = 1; i < platinums.rows.length; i++) {
        const gapDays =
            (new Date(platinums.rows[i].unlocked_at).getTime() - new Date(platinums.rows[i - 1].unlocked_at).getTime()) /
            (1000 * 60 * 60 * 24);
        if (longestPlatinumGapDays === null || gapDays > longestPlatinumGapDays) longestPlatinumGapDays = gapDays;
    }

    // Same shape as the platinums query above, just counted rather than
    // collected (no gap-between-unlocks stat needed for these tiers) - backs
    // the platinum/gold/silver/bronze totals breakdown (#147).
    const golds = await pool.query(
        `select count(*) as count
         from user_achievement_unlocks uau
         join user_platform_accounts upa on upa.id = uau.user_platform_account_id
         join achievement_platform_links apl on apl.id = uau.achievement_platform_link_id
         join canonical_achievements ca on ca.id = apl.canonical_achievement_id
         where upa.user_id = $1 and ca.tier = 'gold' and ${notExcluded("ca.game_id")}`,
        [userId]
    );
    const silvers = await pool.query(
        `select count(*) as count
         from user_achievement_unlocks uau
         join user_platform_accounts upa on upa.id = uau.user_platform_account_id
         join achievement_platform_links apl on apl.id = uau.achievement_platform_link_id
         join canonical_achievements ca on ca.id = apl.canonical_achievement_id
         where upa.user_id = $1 and ca.tier = 'silver' and ${notExcluded("ca.game_id")}`,
        [userId]
    );
    const bronzes = await pool.query(
        `select count(*) as count
         from user_achievement_unlocks uau
         join user_platform_accounts upa on upa.id = uau.user_platform_account_id
         join achievement_platform_links apl on apl.id = uau.achievement_platform_link_id
         join canonical_achievements ca on ca.id = apl.canonical_achievement_id
         where upa.user_id = $1 and ca.tier = 'bronze' and ${notExcluded("ca.game_id")}`,
        [userId]
    );

    // Reuses the same unlocked/total counts the games list already computes
    // (and has already been tested against) rather than re-deriving
    // completion at the canonical-achievement level from scratch.
    const games = await getGamesForUser(userId, { includeHidden: true });
    const fullyCompletedGames = games.filter(
        (g) => Number(g.total_achievements) > 0 && Number(g.unlocked_achievements) === Number(g.total_achievements)
    ).length;
    const syntheticPlatinums = games.filter((g) => g.platinum_synthetic).length;

    return {
        rarestAchievement: rarest.rows[0] ?? null,
        busiestPointsDay: busiestPointsDay.rows[0] ?? null,
        busiestUnlockDay: busiestUnlockDay.rows[0] ?? null,
        oldestUnlock: oldest.rows[0] ?? null,
        totalPlatinums: platinums.rows.length + syntheticPlatinums,
        totalGold: Number(golds.rows[0].count),
        totalSilver: Number(silvers.rows[0].count),
        totalBronze: Number(bronzes.rows[0].count),
        longestPlatinumGapDays: longestPlatinumGapDays !== null ? Math.round(longestPlatinumGapDays) : null,
        fullyCompletedGames,
    };
}

// One row per (achievement, platform link) across the user's whole library -
// same join pattern as getAchievementsForGame below, just scoped to every
// owned game instead of one. Backs the "download my data" export (#26).
export async function getFullExportData(userId: string) {
    const result = await pool.query(
        `select
            g.title as game_title, apl.platform_id,
            ca.name as achievement_name, ca.description, ca.tier, ca.points,
            apl.global_unlock_rarity,
            (uau.id is not null) as unlocked, uau.unlocked_at
         from games g
         join canonical_achievements ca on ca.game_id = g.id
         join achievement_platform_links apl on apl.canonical_achievement_id = ca.id
         left join user_achievement_unlocks uau
                on uau.achievement_platform_link_id = apl.id
               and uau.user_platform_account_id in (
                   select id from user_platform_accounts where user_id = $1
               )
         -- Per-platform, not just per-game - the user might own this game on
         -- one platform but have a second, enrichment-only platform link
         -- attached to it purely to source real rarity data (catalog
         -- enrichment never calls recordOwnership). Without pinning the
         -- check to apl.platform_id too, a game owned on Steam only would
         -- still export a phantom all-locked Xbox section. See #78.
         where exists (
             select 1 from user_owned_games uog
             join user_platform_accounts upa on upa.id = uog.user_platform_account_id
             where upa.user_id = $1 and uog.game_id = g.id and upa.platform_id = apl.platform_id
         )
         order by g.title, apl.platform_id, ca.name`,
        [userId]
    );
    return result.rows;
}

export async function getAchievementsForGame(userId: string, gameId: string) {
    const owns = await pool.query(
        `select 1 from user_owned_games uog
         join user_platform_accounts upa on upa.id = uog.user_platform_account_id
         where upa.user_id = $1 and uog.game_id = $2
         limit 1`,
        [userId, gameId]
    );
    if (!owns.rows[0]) return null;

    const result = await pool.query(
        `select
            ca.id, ca.name, ca.description, ca.tier, ca.points,
            -- A user's own pasted icon (see #32) wins over the auto-detected
            -- one on canonical_achievements.icon_url, same reasoning as
            -- cover art overrides in getGamesForUser above.
            coalesce(
                (select icon_url from user_achievement_icon_overrides where user_id = $1 and canonical_achievement_id = ca.id),
                ca.icon_url
            ) as icon_url,
            apl.platform_id, apl.global_unlock_rarity, gpl.console_variant,
            gpl.id as game_platform_link_id, gpl.platform_title,
            (uau.id is not null) as unlocked, uau.unlocked_at
         from canonical_achievements ca
         join achievement_platform_links apl on apl.canonical_achievement_id = ca.id
         left join game_platform_links gpl
                on gpl.platform_id = apl.platform_id and gpl.platform_game_id = apl.platform_game_id
         left join user_achievement_unlocks uau
                on uau.achievement_platform_link_id = apl.id
               and uau.user_platform_account_id in (
                   select id from user_platform_accounts where user_id = $1
               )
         where ca.game_id = $2
           -- Per-platform, not just per-game (the earlier owns check above
           -- only confirms the user owns this game on *some* platform) - a
           -- game owned on PSN only can still carry an enrichment-only Xbox
           -- achievement_platform_links row sourcing real rarity data, and
           -- without this it'd render as its own all-locked "Xbox 0/N"
           -- section the user never actually played. See #78.
           and exists (
               select 1 from user_owned_games uog
               join user_platform_accounts upa on upa.id = uog.user_platform_account_id
               where upa.user_id = $1 and uog.game_id = ca.game_id and upa.platform_id = apl.platform_id
           )
         order by unlocked desc, apl.global_unlock_rarity asc nulls last`,
        [userId, gameId]
    );
    return result.rows;
}
