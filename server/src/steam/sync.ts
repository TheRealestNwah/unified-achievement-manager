import { pool } from "../db";
import {
    getOwnedGames,
    getSchemaForGame,
    getPlayerAchievements,
    getGlobalAchievementPercentages,
} from "./client";
import {
    getOrCreateCanonicalGame,
    getOrCreateAchievementLink,
    recordUnlock,
    revokeUnlockIfPresent,
    recordOwnership,
    reconcileOwnershipForPlatform,
} from "../sync/canonicalStore";
import { normalizeRarityTiersForGame } from "../scoring/rarityNormalization";
import { SyncSummary } from "../sync/types";

interface SteamSyncState {
    playtimeForever: number;
    rtimeLastPlayed: number;
}

async function getSyncState(userPlatformAccountId: string): Promise<Map<number, SteamSyncState>> {
    const result = await pool.query(
        "select appid, playtime_forever, rtime_last_played from steam_game_sync_state where user_platform_account_id = $1",
        [userPlatformAccountId]
    );
    return new Map(
        result.rows.map((r) => [r.appid, { playtimeForever: r.playtime_forever, rtimeLastPlayed: r.rtime_last_played }])
    );
}

async function saveSyncState(userPlatformAccountId: string, appid: number, playtimeForever: number, rtimeLastPlayed: number) {
    await pool.query(
        `insert into steam_game_sync_state (user_platform_account_id, appid, playtime_forever, rtime_last_played)
         values ($1, $2, $3, $4)
         on conflict (user_platform_account_id, appid) do update set
            playtime_forever = excluded.playtime_forever,
            rtime_last_played = excluded.rtime_last_played`,
        [userPlatformAccountId, appid, playtimeForever, rtimeLastPlayed]
    );
}

// Global rarity shifts slowly (see #27) and this is the same data for every
// user who owns a given game, so it's cached app-wide rather than per
// account - unlike steam_game_sync_state above.
const GLOBAL_RARITY_TTL_MS = 24 * 60 * 60 * 1000;

async function getCachedGlobalPercentages(appid: number): Promise<Map<string, number>> {
    const cached = await pool.query("select percentages, fetched_at from steam_global_rarity_cache where appid = $1", [
        appid,
    ]);
    if (cached.rows[0] && Date.now() - cached.rows[0].fetched_at.getTime() < GLOBAL_RARITY_TTL_MS) {
        return new Map(Object.entries(cached.rows[0].percentages));
    }

    const fresh = await getGlobalAchievementPercentages(appid);
    await pool.query(
        `insert into steam_global_rarity_cache (appid, percentages, fetched_at)
         values ($1, $2, now())
         on conflict (appid) do update set percentages = excluded.percentages, fetched_at = excluded.fetched_at`,
        [appid, JSON.stringify(Object.fromEntries(fresh))]
    );
    return fresh;
}

export async function syncSteamAccount(userPlatformAccountId: string, steamId: string): Promise<SyncSummary> {
    const games = await getOwnedGames(steamId);
    const syncState = await getSyncState(userPlatformAccountId);
    let achievementsUnlocked = 0;
    let achievementsRevoked = 0;

    for (const game of games) {
        // Neither field can change without the user actually playing the
        // game, and achievement unlocks only ever happen during play - so if
        // both are unchanged since last sync, nothing about this game
        // (including a from-scratch "does it have achievements" check) needs
        // re-fetching. Comparing both rather than just playtime_forever
        // closes the edge case of an achievement unlocking within the same
        // whole-minute window as the previous sync's playtime reading.
        // Verified live against a real 494-game library that both fields are
        // present and well-formed (see PR #21's test plan).
        //
        // Trade-off: this also means a revoked achievement (see #57) only
        // gets caught the next time this game is actually played - a stale
        // unlock on a game the user hasn't touched since stays stale until
        // they do. Accepted rather than dropping this skip entirely, which
        // would mean re-fetching every game's achievements on every sync.
        const previous = syncState.get(game.appid);
        if (previous && previous.playtimeForever === game.playtime_forever && previous.rtimeLastPlayed === game.rtime_last_played) {
            continue;
        }

        const schema = await getSchemaForGame(game.appid);
        if (schema.length === 0) {
            // Game has no achievements.
            await saveSyncState(userPlatformAccountId, game.appid, game.playtime_forever, game.rtime_last_played);
            continue;
        }

        const [playerAchievements, globalPercentages] = await Promise.all([
            getPlayerAchievements(game.appid, steamId),
            getCachedGlobalPercentages(game.appid),
        ]);
        const unlockedByName = new Map(playerAchievements.map((a) => [a.apiname, a]));

        // Steam's CDN serves box art at a predictable per-appid URL - no API
        // call needed, confirmed live (200) against a real appid. The
        // library capsule (portrait 600x900, the same shape modern Steam's
        // own library grid uses and what SteamGridDB's default grid images
        // match) rather than the landscape header capsule - a landscape
        // image cropped into the dashboard's portrait cover box just shows a
        // cropped sliver of the middle.
        const coverImageUrl = `https://cdn.cloudflare.steamstatic.com/steam/apps/${game.appid}/library_600x900.jpg`;
        const gameId = await getOrCreateCanonicalGame("steam", String(game.appid), game.name, coverImageUrl);
        await recordOwnership(userPlatformAccountId, gameId);

        for (const achievement of schema) {
            const linkId = await getOrCreateAchievementLink(
                gameId,
                "steam",
                String(game.appid),
                achievement.name,
                achievement.displayName,
                achievement.description,
                globalPercentages.get(achievement.name),
                undefined,
                achievement.iconUrl
            );

            const unlock = unlockedByName.get(achievement.name);
            if (!unlock?.achieved) {
                // Steam now reports this as not achieved - correct a
                // previously recorded unlock if one exists (a stats reset,
                // or an achievement unlocked and later removed with a tool
                // like Steam Achievement Manager - see #57), rather than
                // leaving it credited forever.
                if (await revokeUnlockIfPresent(userPlatformAccountId, linkId)) achievementsRevoked++;
                continue;
            }

            const isNew = await recordUnlock(userPlatformAccountId, linkId, new Date(unlock.unlocktime * 1000));
            if (isNew) achievementsUnlocked++;
        }

        // This game's full achievement list (and thus its rarity
        // distribution) is only known now that every achievement has been
        // inserted - re-resolve tiers with that context (see issue #10).
        await normalizeRarityTiersForGame(gameId);
        // Only once the game is fully recorded - saved earlier, a sync that
        // failed partway through this game (a rate limit, a network error)
        // would skip it from then on until it was played again (see #385).
        await saveSyncState(userPlatformAccountId, game.appid, game.playtime_forever, game.rtime_last_played);
    }

    // Built from every appid Steam still reports owning, not just the ones
    // processed above - a game skipped this sync by the playtime cache (see
    // above) is still owned and must not look "missing" to reconciliation.
    const { gamesReconciled, achievementsRevoked: reconciledRevocations } = await reconcileOwnershipForPlatform(
        userPlatformAccountId,
        "steam",
        games.map((g) => String(g.appid))
    );
    achievementsRevoked += reconciledRevocations;

    await pool.query("update user_platform_accounts set last_synced_at = now() where id = $1", [
        userPlatformAccountId,
    ]);

    return { gamesProcessed: games.length, achievementsUnlocked, achievementsRevoked, gamesReconciled };
}
