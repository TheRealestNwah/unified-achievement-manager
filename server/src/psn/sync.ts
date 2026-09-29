import { pool } from "../db";
import { getUserTitles, getTitleTrophies, getUserTrophiesEarnedForTitle } from "./client";
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

export async function syncPsnAccount(userPlatformAccountId: string, accessToken: string): Promise<SyncSummary> {
    const titles = await getUserTitles(accessToken);
    let achievementsUnlocked = 0;
    let achievementsRevoked = 0;

    for (const title of titles) {
        const [definitions, earned] = await Promise.all([
            getTitleTrophies(accessToken, title.npCommunicationId, title.npServiceName),
            getUserTrophiesEarnedForTitle(accessToken, title.npCommunicationId, title.npServiceName),
        ]);
        if (definitions.length === 0) continue;

        const earnedById = new Map(earned.map((t) => [t.trophyId, t]));
        const gameId = await getOrCreateCanonicalGame(
            "psn",
            title.npCommunicationId,
            title.trophyTitleName,
            title.trophyTitleIconUrl,
            title.trophyTitlePlatform
        );
        await recordOwnership(userPlatformAccountId, gameId);

        for (const trophy of definitions) {
            const status = earnedById.get(trophy.trophyId);
            const rarity = status?.trophyEarnedRate ? Number(status.trophyEarnedRate) : undefined;

            const linkId = await getOrCreateAchievementLink(
                gameId,
                "psn",
                title.npCommunicationId,
                String(trophy.trophyId),
                trophy.trophyName ?? "Hidden trophy",
                trophy.trophyDetail,
                rarity,
                { tier: trophy.trophyType, tierSource: "psn_native" },
                trophy.trophyIconUrl
            );

            if (!status?.earned) {
                // See #57 - correct a previously recorded unlock if PSN now
                // reports this as not earned, rather than leaving it
                // credited forever.
                if (await revokeUnlockIfPresent(userPlatformAccountId, linkId)) achievementsRevoked++;
                continue;
            }

            const isNew = await recordUnlock(
                userPlatformAccountId,
                linkId,
                status.earnedDateTime ? new Date(status.earnedDateTime) : null
            );
            if (isNew) achievementsUnlocked++;
        }

        // PSN's own trophies are all psn_native, so this is a no-op unless
        // this merged game also has still-unmatched rarity_fallback
        // achievements from another platform's copy.
        await normalizeRarityTiersForGame(gameId);
    }

    const { gamesReconciled, achievementsRevoked: reconciledRevocations } = await reconcileOwnershipForPlatform(
        userPlatformAccountId,
        "psn",
        titles.map((t) => t.npCommunicationId)
    );
    achievementsRevoked += reconciledRevocations;

    await pool.query("update user_platform_accounts set last_synced_at = now() where id = $1", [
        userPlatformAccountId,
    ]);

    return { gamesProcessed: titles.length, achievementsUnlocked, achievementsRevoked, gamesReconciled };
}
