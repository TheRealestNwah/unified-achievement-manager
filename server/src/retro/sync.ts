import { pool } from "../db";
import { getUserGames, getGameProgress } from "./client";
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

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// RetroAchievements' API has no documented hard rate limit, but community
// guidance is to stay well under ~1 request/second - a large library means
// one call per game, so this throttles proactively instead of reacting to a
// ban after the fact (unlike Xbox's client, which retries reactively on a
// real 429 from a service that does document its limits).
const REQUEST_DELAY_MS = 300;

export async function syncRetroAccount(
    userPlatformAccountId: string,
    username: string,
    apiKey: string
): Promise<SyncSummary> {
    const games = await getUserGames(username, apiKey);
    let achievementsUnlocked = 0;
    let achievementsRevoked = 0;

    for (const game of games) {
        const achievements = await getGameProgress(username, apiKey, game.gameId);
        if (achievements.length === 0) {
            await sleep(REQUEST_DELAY_MS);
            continue;
        }

        const gameId = await getOrCreateCanonicalGame(
            "retroachievements",
            game.gameId,
            game.title,
            game.coverImageUrl
        );
        await recordOwnership(userPlatformAccountId, gameId);

        for (const achievement of achievements) {
            const linkId = await getOrCreateAchievementLink(
                gameId,
                "retroachievements",
                game.gameId,
                achievement.id,
                achievement.name,
                achievement.description,
                achievement.globalUnlockRarity,
                undefined,
                achievement.iconUrl
            );

            if (!achievement.isUnlocked) {
                // See #57 - correct a previously recorded unlock if RA now
                // reports this as not earned, rather than leaving it
                // credited forever.
                if (await revokeUnlockIfPresent(userPlatformAccountId, linkId)) achievementsRevoked++;
                continue;
            }

            // RA's DateEarned(Hardcore) is "YYYY-MM-DD HH:MM:SS" in UTC with
            // no timezone marker - reformat to a real ISO instant.
            const unlockedAt = achievement.unlockedAt
                ? new Date(`${achievement.unlockedAt.replace(" ", "T")}Z`)
                : null;

            const isNew = await recordUnlock(userPlatformAccountId, linkId, unlockedAt);
            if (isNew) achievementsUnlocked++;
        }

        // This game's full achievement list is only known now that every
        // achievement has been inserted - re-resolve tiers with that
        // context (see rarityNormalization.ts, issue #10).
        await normalizeRarityTiersForGame(gameId);
        await sleep(REQUEST_DELAY_MS);
    }

    const { gamesReconciled, achievementsRevoked: reconciledRevocations } = await reconcileOwnershipForPlatform(
        userPlatformAccountId,
        "retroachievements",
        games.map((g) => g.gameId)
    );
    achievementsRevoked += reconciledRevocations;

    await pool.query("update user_platform_accounts set last_synced_at = now() where id = $1", [
        userPlatformAccountId,
    ]);

    return { gamesProcessed: games.length, achievementsUnlocked, achievementsRevoked, gamesReconciled };
}
