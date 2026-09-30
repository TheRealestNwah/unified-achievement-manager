import { pool } from "../db";
import { searchMarketplace, getTitleIdForProduct, getAchievementsForTitle, XboxApiError, XboxMarketplaceProduct } from "../xbox/client";
import { getOrCreateAchievementLink } from "../sync/canonicalStore";
import { normalize } from "./normalize";
import { config } from "../config";
import { decryptCredential } from "../security/credentials";

export interface XboxCatalogEnrichmentResult {
    gamesEnriched: number;
}

// Enrichment shares the user's own OpenXBL key, whose free tier allows only
// so many requests an hour. Left unbounded, every matching pass (after any
// platform's sync) spent the whole window on catalog lookups, three or so
// calls per game, and the user's own Xbox sync then failed with a 429 on its
// first request (see #478). So a pass looks up a small batch at most once an
// hour, and a 429 counts as that hour's pass.
export const XBOX_ENRICHMENT_GAMES_PER_RUN = 10;
export const XBOX_ENRICHMENT_INTERVAL_MS = 60 * 60 * 1000;
let nextRunAllowedAt = 0;

export function resetXboxEnrichmentThrottle(): void {
    nextRunAllowedAt = 0;
}

// Same shape as matching/steamCatalogEnrichment.ts, for Xbox - see #50's
// research. OpenXBL's achievements/title endpoint returns a title's full
// catalog (definitions + real rarity) even for an account that's never
// played it, confirmed live against Halo Infinite - so any linked Xbox
// account's personal API key works as a bearer credential for catalog
// lookups regardless of whose library the target game is actually in.
export async function enrichGamesWithXboxCatalog(): Promise<XboxCatalogEnrichmentResult> {
    const anyXboxAccount = await pool.query(
        "select access_token from user_platform_accounts where platform_id = 'xbox' limit 1"
    );
    // No one has linked Xbox at all - no key available to search with, and
    // nothing to do until someone does.
    if (!anyXboxAccount.rows[0]) return { gamesEnriched: 0 };
    if (Date.now() < nextRunAllowedAt) return { gamesEnriched: 0 };
    const apiKey = decryptCredential(anyXboxAccount.rows[0].access_token as string, config.credentialEncryptionKey);

    const candidates = await pool.query(`
        select distinct g.id, g.title
        from games g
        join canonical_achievements ca on ca.game_id = g.id
        where not exists (
            select 1 from achievement_platform_links apl
            where apl.canonical_achievement_id = ca.id and apl.platform_id = 'xbox'
        )
        and not exists (
            select 1 from xbox_catalog_enrichment_attempts a where a.game_id = g.id
        )
        limit $1
    `, [XBOX_ENRICHMENT_GAMES_PER_RUN]);
    if (candidates.rows.length === 0) return { gamesEnriched: 0 };
    nextRunAllowedAt = Date.now() + XBOX_ENRICHMENT_INTERVAL_MS;

    let gamesEnriched = 0;
    for (const game of candidates.rows) {
        let enriched: boolean;
        try {
            enriched = await enrichGame(apiKey, game.id, game.title);
        } catch (err) {
            // OpenXBL's marketplace endpoints turned out to be far more
            // tightly rate-limited than achievements (confirmed live: a
            // bulk enrichment run hits 429 well before getting through a
            // real library, even with get()'s own built-in retry/backoff
            // exhausted). Stop enriching for this run rather than crashing
            // the rest of runMatching() (Steam enrichment, achievement
            // matching, rescoring) over it - the remaining candidates just
            // get picked up on a later run. Deliberately NOT marked as
            // attempted, so this game is retried rather than treated as a
            // permanent miss.
            if (err instanceof XboxApiError && err.status === 429) break;
            throw err;
        }
        if (enriched) gamesEnriched++;
        await pool.query(
            "insert into xbox_catalog_enrichment_attempts (game_id) values ($1) on conflict (game_id) do nothing",
            [game.id]
        );
    }
    return { gamesEnriched };
}

async function enrichGame(apiKey: string, gameId: string, title: string): Promise<boolean> {
    const titleId = await findXboxTitleId(apiKey, title);
    if (!titleId) return false;

    // Same "don't attach a real user's already-synced platform data to the
    // wrong game" guard as the Steam version - left to matchGames' own
    // exact-title merge instead of guessed at here.
    const existingLink = await pool.query(
        "select 1 from game_platform_links where platform_id = 'xbox' and platform_game_id = $1",
        [titleId]
    );
    if (existingLink.rows[0]) return false;

    // Reuses the exact same function xbox/sync.ts's real per-user sync
    // calls - it has no dependency on the API key's own account owning or
    // having played this title, only on the titleId being valid.
    const achievements = await getAchievementsForTitle(apiKey, titleId);
    if (achievements.length === 0) return false;

    const insertedLink = await pool.query(
        "insert into game_platform_links (game_id, platform_id, platform_game_id, platform_title) values ($1, 'xbox', $2, $3) on conflict (platform_id, platform_game_id) do nothing",
        [gameId, titleId, title]
    );
    // Another sync or enrichment pass may have claimed this link while the
    // catalog request was in flight. Do not attach its achievements to this
    // canonical game; the owner is intentionally left to matchGames.
    if (insertedLink.rowCount === 0) return false;

    for (const achievement of achievements) {
        await getOrCreateAchievementLink(
            gameId,
            "xbox",
            titleId,
            achievement.id,
            achievement.name,
            achievement.description,
            achievement.rarityPercent,
            undefined,
            achievement.iconUrl
        );
    }

    return true;
}

async function findXboxTitleId(apiKey: string, title: string): Promise<string | undefined> {
    let products: XboxMarketplaceProduct[];
    try {
        products = await searchMarketplace(apiKey, title);
    } catch (err) {
        if (err instanceof XboxApiError && err.status === 429) throw err;
        return undefined;
    }

    const normalizedTitle = normalize(title);
    const matches = products.filter((p) => p.type === "Game" && normalize(p.title) === normalizedTitle);

    // More than one exact-title match isn't necessarily ambiguous the way it
    // would be for Steam - the Store commonly lists the same game twice (PC
    // + Xbox editions with identical titles), with only one listing
    // actually carrying a title ID. getTitleIdForProduct's own docs use
    // exactly this case (Halo Infinite) as their example. Try each match in
    // turn and use the first one that resolves, rather than treating
    // multiple hits as ambiguous and skipping.
    for (const match of matches) {
        const titleId = await getTitleIdForProduct(apiKey, match.productId);
        if (titleId) return titleId;
    }
    return undefined;
}
