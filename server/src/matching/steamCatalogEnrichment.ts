import { pool } from "../db";
import { searchApps, getSchemaForGame, getGlobalAchievementPercentages } from "../steam/client";
import { getOrCreateAchievementLink } from "../sync/canonicalStore";
import { normalize } from "./normalize";
import { hasSteamApiKey } from "../settings/steamApiKey";

export interface SteamCatalogEnrichmentResult {
    gamesEnriched: number;
}

// Backfills real Steam achievement/rarity data for a canonical game that has
// no Steam copy linked by any user, so matchAchievementsForGame (run right
// after this in runMatching) has something real to merge it against instead
// of that game staying at rarity_fallback's "unknown rarity" bronze default
// forever just because no one happens to have synced it from Steam. Prompted
// by a live report: a user's GOG-only copy of Cyberpunk 2077 graded every
// achievement bronze despite Steam publishing real per-achievement unlock
// rates for the same game.
export async function enrichGamesWithSteamCatalog(): Promise<SteamCatalogEnrichmentResult> {
    // The Steam key is optional since Steam stopped being the sign-in (see
    // #393). Nothing is recorded as attempted, so adding a key later still
    // enriches these games.
    if (!hasSteamApiKey()) return { gamesEnriched: 0 };
    const candidates = await pool.query(`
        select distinct g.id, g.title
        from games g
        join canonical_achievements ca on ca.game_id = g.id
        where not exists (
            select 1 from achievement_platform_links apl
            where apl.canonical_achievement_id = ca.id and apl.platform_id = 'steam'
        )
        and not exists (
            select 1 from steam_catalog_enrichment_attempts a where a.game_id = g.id
        )
    `);

    let gamesEnriched = 0;
    for (const game of candidates.rows) {
        const enriched = await enrichGame(game.id, game.title);
        if (enriched) gamesEnriched++;
        // Recorded regardless of outcome - a miss this time (no Steam
        // release, or no achievements) isn't going to become a hit later,
        // so this game is never searched again.
        await pool.query(
            "insert into steam_catalog_enrichment_attempts (game_id) values ($1) on conflict (game_id) do nothing",
            [game.id]
        );
    }
    return { gamesEnriched };
}

async function enrichGame(gameId: string, title: string): Promise<boolean> {
    const appId = await findSteamAppId(title);
    if (!appId) return false;

    // This exact appid might already belong to a *different* canonical game
    // - a real user's own separately-synced Steam copy that title-based
    // matching (matchGames) hasn't merged with this one yet, e.g. because the
    // two platforms format the title differently. Attaching it here too
    // would misattribute that user's synced data to this game, so this is
    // left to matchGames' own exact-title merge rather than guessed at here.
    const existingLink = await pool.query(
        "select 1 from game_platform_links where platform_id = 'steam' and platform_game_id = $1",
        [String(appId)]
    );
    if (existingLink.rows[0]) return false;

    const schema = await getSchemaForGame(appId);
    if (schema.length === 0) return false; // no Steam achievements for this game

    const globalPercentages = await getGlobalAchievementPercentages(appId);

    const insertedLink = await pool.query(
        "insert into game_platform_links (game_id, platform_id, platform_game_id, platform_title) values ($1, 'steam', $2, $3) on conflict (platform_id, platform_game_id) do nothing",
        [gameId, String(appId), title]
    );
    // The pre-fetch lookup is not a lock: a concurrent sync can claim this
    // app while Steam catalog requests are in flight. Leave that data with
    // its owner instead of writing achievement links to this game.
    if (insertedLink.rowCount === 0) return false;

    for (const achievement of schema) {
        // Always creates a new canonical_achievements row here rather than
        // reusing an existing GOG/etc one for "the same" achievement -
        // getOrCreateAchievementLink has no way to know they're the same
        // real achievement. That's fine: matchAchievementsForGame (run right
        // after this, in runMatching) merges same-named achievements within
        // a game and re-resolves tier from whichever platform now has real
        // rarity data, which is the whole point of this enrichment step.
        await getOrCreateAchievementLink(
            gameId,
            "steam",
            String(appId),
            achievement.name,
            achievement.displayName,
            achievement.description,
            globalPercentages.get(achievement.name),
            undefined,
            achievement.iconUrl
        );
    }

    return true;
}

async function findSteamAppId(title: string): Promise<number | undefined> {
    const results = await searchApps(title);
    const normalizedTitle = normalize(title);
    const matches = results.filter((r) => r.type === "app" && normalize(r.name) === normalizedTitle);

    // Zero or ambiguous (e.g. a remaster/re-release sharing an exact
    // normalized title) - skip rather than guess, the same exact-match-only
    // philosophy matchGames uses for the same reason: a wrong guess here
    // attaches one game's real achievement data to a different game.
    if (matches.length !== 1) return undefined;
    return matches[0].id;
}
