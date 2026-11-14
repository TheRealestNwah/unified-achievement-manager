import { pool } from "../db";
import { getConsoleIds, getGamesForConsole, getGameCatalogEntry, RetroApiError } from "../retro/client";
import { getOrCreateAchievementLink } from "../sync/canonicalStore";
import { normalize } from "./normalize";
import { config } from "../config";
import { decryptCredential } from "../security/credentials";

export interface RetroCatalogEnrichmentResult {
    gamesEnriched: number;
}

// RA has no free-text game search (API_GetGameList.php needs a console ID,
// confirmed against the docs - see #50), so a title lookup means walking
// every console's game list once and matching client-side. ~85 consoles /
// ~60k games total (confirmed live), so this is cached in memory rather than
// rebuilt on every runMatching() call - a fresh process just rebuilds it
// once on first use.
let cachedIndex: Map<string, string[]> | null = null;
let cachedIndexAt = 0;
const INDEX_TTL_MS = 24 * 60 * 60 * 1000;

async function getTitleIndex(apiKey: string): Promise<Map<string, string[]>> {
    if (cachedIndex && Date.now() - cachedIndexAt < INDEX_TTL_MS) return cachedIndex;

    const consoles = await getConsoleIds(apiKey);
    const index = new Map<string, string[]>();
    for (const console of consoles) {
        let games;
        try {
            games = await getGamesForConsole(apiKey, console.id);
        } catch (err) {
            // A rate limit or transient failure partway through building the
            // index shouldn't throw away everything already collected - the
            // remaining consoles just aren't searchable until the next
            // rebuild, same graceful-degradation reasoning as the
            // enrichment loop below.
            if (err instanceof RetroApiError) break;
            throw err;
        }
        for (const game of games) {
            const key = normalize(game.title);
            const list = index.get(key) ?? [];
            list.push(game.gameId);
            index.set(key, list);
        }
    }

    cachedIndex = index;
    cachedIndexAt = Date.now();
    return index;
}

// Same shape as matching/steamCatalogEnrichment.ts and
// matching/xboxCatalogEnrichment.ts, for RetroAchievements - see #50's
// research. Any currently-linked RA account's Web API key is used as the
// credential; API_GetGameExtended needs no username (confirmed live), so
// results aren't scoped to that account's own library.
export async function enrichGamesWithRetroCatalog(): Promise<RetroCatalogEnrichmentResult> {
    const anyRetroAccount = await pool.query(
        "select access_token from user_platform_accounts where platform_id = 'retroachievements' limit 1"
    );
    if (!anyRetroAccount.rows[0]) return { gamesEnriched: 0 };
    const apiKey = decryptCredential(anyRetroAccount.rows[0].access_token as string, config.credentialEncryptionKey);

    const candidates = await pool.query(`
        select distinct g.id, g.title
        from games g
        join canonical_achievements ca on ca.game_id = g.id
        where not exists (
            select 1 from achievement_platform_links apl
            where apl.canonical_achievement_id = ca.id and apl.platform_id = 'retroachievements'
        )
        and not exists (
            select 1 from retro_catalog_enrichment_attempts a where a.game_id = g.id
        )
    `);

    let gamesEnriched = 0;
    for (const game of candidates.rows) {
        let enriched: boolean;
        try {
            enriched = await enrichGame(apiKey, game.id, game.title);
        } catch (err) {
            // Same reasoning as the Xbox version: stop enriching for this
            // run rather than crashing the rest of runMatching() over a
            // rate limit or transient failure. Not marked as attempted, so
            // it's retried on a later run instead of treated as a
            // permanent miss.
            if (err instanceof RetroApiError) break;
            throw err;
        }
        if (enriched) gamesEnriched++;
        await pool.query(
            "insert into retro_catalog_enrichment_attempts (game_id) values ($1) on conflict (game_id) do nothing",
            [game.id]
        );
    }
    return { gamesEnriched };
}

async function enrichGame(apiKey: string, gameId: string, title: string): Promise<boolean> {
    const index = await getTitleIndex(apiKey);
    const matches = index.get(normalize(title));
    // No match, or more than one game (on possibly different consoles)
    // shares this exact title - genuinely different games with the same
    // name are common enough on RA (many licensed titles were made more
    // than once across consoles) that guessing which one is too risky, same
    // exact-match-only discipline as the Steam/Xbox versions.
    if (!matches || matches.length !== 1) return false;
    const raGameId = matches[0];

    const existingLink = await pool.query(
        "select 1 from game_platform_links where platform_id = 'retroachievements' and platform_game_id = $1",
        [raGameId]
    );
    if (existingLink.rows[0]) return false;

    const achievements = await getGameCatalogEntry(apiKey, raGameId);
    if (achievements.length === 0) return false;

    const insertedLink = await pool.query(
        "insert into game_platform_links (game_id, platform_id, platform_game_id, platform_title) values ($1, 'retroachievements', $2, $3) on conflict (platform_id, platform_game_id) do nothing",
        [gameId, raGameId, title]
    );
    // The link may have been created after the lookup above by another sync
    // or enrichment pass. Avoid assigning that platform's achievements to
    // the wrong canonical game.
    if (insertedLink.rowCount === 0) return false;

    for (const achievement of achievements) {
        await getOrCreateAchievementLink(
            gameId,
            { platformId: "retroachievements", platformGameId: raGameId, platformAchievementId: achievement.id },
            { name: achievement.name, description: achievement.description, rarity: achievement.globalUnlockRarity, iconUrl: achievement.iconUrl }
        );
    }

    return true;
}
