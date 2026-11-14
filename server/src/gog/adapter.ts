import { PlatformAdapter } from "../sync/platformAdapter";
import { exchangeRefreshTokenForTokens, getAchievementsForGame, getOwnedGameIds, getProduct } from "./client";

// GOG's achievements API gives no global unlock rarity (unlike Steam's
// percentages endpoint, PSN's trophyEarnedRate, or RA's NumAwarded), so every
// GOG achievement is treated as common rather than over-credited, same as any
// other platform's achievement with no rarity signal.
export const gogAdapter: PlatformAdapter = {
    platformId: "gog",

    async connect(account) {
        // GOG access tokens are short-lived, so every sync refreshes first.
        const tokens = await exchangeRefreshTokenForTokens(account.refreshToken!);
        const gogUserId = account.platformAccountId;

        return {
            refreshedCredentials: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken },

            async listOwnedGames() {
                return (await getOwnedGameIds(tokens.accessToken)).map((platformGameId) => ({ platformGameId, details: undefined }));
            },

            async fetchAchievementList(game) {
                const achievements = await getAchievementsForGame(tokens.accessToken, game.platformGameId, gogUserId);
                if (achievements.length === 0) return { kind: "none" };
                // Only fetched for games with achievements: a separate call.
                const product = await getProduct(game.platformGameId);
                return {
                    kind: "achievements",
                    title: product.title,
                    coverImageUrl: product.coverImageUrl,
                    achievements: achievements.map((a) => ({
                        id: a.id,
                        name: a.name,
                        description: a.description,
                        iconUrl: a.iconUrl,
                        unlocked: a.isUnlocked,
                        unlockedAt: a.unlockedAt ? new Date(a.unlockedAt) : null,
                    })),
                };
            },
        };
    },
};
