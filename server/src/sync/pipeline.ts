import { pool } from "../db";
import { config } from "../config";
import { decryptCredential, encryptCredential } from "../security/credentials";
import { normalizeRarityTiersForGame } from "../scoring/rarityNormalization";
import {
    getOrCreateAchievementLink,
    getOrCreateCanonicalGame,
    reconcileOwnershipForPlatform,
    recordOwnership,
    recordUnlock,
    revokeUnlockIfPresent,
} from "./canonicalStore";
import { AchievementEntry, LinkedAccount, OwnedGame, PlatformAdapter } from "./platformAdapter";
import { SyncSummary } from "./types";

// The sync pipeline (see GLOSSARY.md): turns what one platform adapter
// reports into library changes. The same steps run for every platform, so a
// fix here is a fix for all of them.
export async function runSyncPipeline(adapter: PlatformAdapter, accountId: string): Promise<SyncSummary> {
    const account = await loadLinkedAccount(accountId);
    const platformId = adapter.platformId;

    const session = await adapter.connect(account);
    if (session.refreshedCredentials) await saveCredentials(accountId, session.refreshedCredentials.accessToken, session.refreshedCredentials.refreshToken);

    const ownedGames = await session.listOwnedGames();
    const savedMarkers = await loadChangeMarkers(accountId);
    let achievementsUnlocked = 0;
    let achievementsRevoked = 0;

    for (const game of ownedGames) {
        if (game.hasAchievements === false) continue;
        if (game.changeMarker !== undefined && savedMarkers.get(game.platformGameId) === game.changeMarker) continue;

        const list = await session.fetchAchievementList(game);
        if (list.kind === "skip") {
            console.warn(`${platformId}: skipped ${game.platformGameId}: ${list.reason}`);
            continue;
        }

        if (list.kind === "achievements" && list.achievements.length > 0) {
            const gameId = await getOrCreateCanonicalGame(platformId, game.platformGameId, list.title, list.coverImageUrl, list.consoleVariant);
            await recordOwnership(accountId, gameId);
            for (const achievement of list.achievements) {
                const result = await recordAchievement(accountId, platformId, gameId, game, achievement);
                if (result === "unlocked") achievementsUnlocked++;
                if (result === "revoked") achievementsRevoked++;
            }
            await normalizeRarityTiersForGame(gameId);
        }

        // Only after the game is fully recorded, so a sync cut off partway
        // (a rate limit, say) picks this game up again next time (see #385).
        if (game.changeMarker !== undefined) await saveChangeMarker(accountId, game.platformGameId, game.changeMarker);
    }

    // From every owned game, including skipped ones, so a game that wasn't
    // fetched this time is never mistaken for one the account lost.
    const reconciled = await reconcileOwnershipForPlatform(
        accountId,
        platformId,
        ownedGames.map((g) => g.platformGameId)
    );
    achievementsRevoked += reconciled.achievementsRevoked;

    await pool.query("update user_platform_accounts set last_synced_at = now() where id = $1", [accountId]);

    return {
        gamesProcessed: ownedGames.length,
        achievementsUnlocked,
        achievementsRevoked,
        gamesReconciled: reconciled.gamesReconciled,
    };
}

async function recordAchievement(
    accountId: string,
    platformId: string,
    gameId: string,
    game: OwnedGame,
    achievement: AchievementEntry
): Promise<"unlocked" | "revoked" | "unchanged"> {
    const linkId = await getOrCreateAchievementLink(
        gameId,
        platformId,
        game.platformGameId,
        achievement.id,
        achievement.name,
        achievement.description,
        achievement.rarity,
        achievement.nativeTier,
        achievement.iconUrl
    );
    if (!achievement.unlocked) {
        // The platform now reports it locked: correct a stored unlock rather
        // than leave it credited forever (see #57).
        return (await revokeUnlockIfPresent(accountId, linkId)) ? "revoked" : "unchanged";
    }
    return (await recordUnlock(accountId, linkId, achievement.unlockedAt)) ? "unlocked" : "unchanged";
}

async function loadLinkedAccount(accountId: string): Promise<LinkedAccount> {
    const result = await pool.query(
        "select id, platform_account_id, access_token, refresh_token, local_folder from user_platform_accounts where id = $1",
        [accountId]
    );
    const row = result.rows[0];
    if (!row) throw new Error("This account is no longer linked.");
    return {
        id: row.id,
        platformAccountId: row.platform_account_id,
        accessToken: row.access_token ? decryptCredential(row.access_token, config.credentialEncryptionKey) : null,
        refreshToken: row.refresh_token ? decryptCredential(row.refresh_token, config.credentialEncryptionKey) : null,
        localFolder: row.local_folder ?? null,
    };
}

async function saveCredentials(accountId: string, accessToken: string, refreshToken: string): Promise<void> {
    await pool.query("update user_platform_accounts set access_token = $1, refresh_token = $2 where id = $3", [
        encryptCredential(accessToken, config.credentialEncryptionKey),
        encryptCredential(refreshToken, config.credentialEncryptionKey),
        accountId,
    ]);
}

async function loadChangeMarkers(accountId: string): Promise<Map<string, string>> {
    const result = await pool.query("select platform_game_id, marker from change_markers where user_platform_account_id = $1", [accountId]);
    return new Map(result.rows.map((r) => [r.platform_game_id as string, r.marker as string]));
}

async function saveChangeMarker(accountId: string, platformGameId: string, marker: string): Promise<void> {
    await pool.query(
        `insert into change_markers (user_platform_account_id, platform_game_id, marker) values ($1, $2, $3)
         on conflict (user_platform_account_id, platform_game_id) do update set marker = excluded.marker`,
        [accountId, platformGameId, marker]
    );
}
