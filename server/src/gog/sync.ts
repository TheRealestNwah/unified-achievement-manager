import { pool } from "../db";
import { getOwnedGameIds, getProduct, getAchievementsForGame } from "./client";
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

// GOG's achievements API gives no global unlock rarity (unlike Steam's
// percentages endpoint, PSN's trophyEarnedRate, or RA's NumAwarded), so every
// GOG achievement falls back to resolveTierFromRarity's undefined case -
// treated as common rather than over-crediting it, same as any other
// platform's achievement with no rarity signal.
export async function syncGogAccount(userPlatformAccountId: string, accessToken: string, gogUserId: string): Promise<SyncSummary> {
    const ownedIds = await getOwnedGameIds(accessToken);
    let gamesProcessed = 0;
    let achievementsUnlocked = 0;
    let achievementsRevoked = 0;

    for (const productId of ownedIds) {
        const achievements = await getAchievementsForGame(accessToken, productId, gogUserId);
        if (achievements.length === 0) continue;

        const product = await getProduct(productId);
        const gameId = await getOrCreateCanonicalGame("gog", productId, product.title, product.coverImageUrl);
        await recordOwnership(userPlatformAccountId, gameId);
        gamesProcessed++;

        for (const achievement of achievements) {
            const linkId = await getOrCreateAchievementLink(
                gameId,
                "gog",
                productId,
                achievement.id,
                achievement.name,
                achievement.description,
                undefined,
                undefined,
                achievement.iconUrl
            );

            if (!achievement.isUnlocked) {
                // See #57 - correct a previously recorded unlock if GOG now
                // reports this as not unlocked, rather than leaving it
                // credited forever.
                if (await revokeUnlockIfPresent(userPlatformAccountId, linkId)) achievementsRevoked++;
                continue;
            }

            const isNew = await recordUnlock(
                userPlatformAccountId,
                linkId,
                achievement.unlockedAt ? new Date(achievement.unlockedAt) : null
            );
            if (isNew) achievementsUnlocked++;
        }

        await normalizeRarityTiersForGame(gameId);
    }

    const { gamesReconciled, achievementsRevoked: reconciledRevocations } = await reconcileOwnershipForPlatform(
        userPlatformAccountId,
        "gog",
        ownedIds
    );
    achievementsRevoked += reconciledRevocations;

    await pool.query("update user_platform_accounts set last_synced_at = now() where id = $1", [
        userPlatformAccountId,
    ]);

    return { gamesProcessed, achievementsUnlocked, achievementsRevoked, gamesReconciled };
}
