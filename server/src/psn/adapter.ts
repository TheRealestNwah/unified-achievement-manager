import { PlatformAdapter } from "../sync/platformAdapter";
import { exchangeRefreshTokenForTokens, getTitleTrophies, getUserTitles, getUserTrophiesEarnedForTitle, PsnTitle } from "./client";

export const psnAdapter: PlatformAdapter<PsnTitle> = {
    platformId: "psn",

    async connect(account) {
        // PSN access tokens last roughly an hour, so every sync refreshes
        // unconditionally rather than tracking expiry.
        const tokens = await exchangeRefreshTokenForTokens(account.refreshToken!);

        return {
            refreshedCredentials: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken },

            async listOwnedGames() {
                return (await getUserTitles(tokens.accessToken)).map((title) => ({ platformGameId: title.npCommunicationId, details: title }));
            },

            async fetchAchievementList(game) {
                const title = game.details;
                const [definitions, earned] = await Promise.all([
                    getTitleTrophies(tokens.accessToken, title.npCommunicationId, title.npServiceName),
                    getUserTrophiesEarnedForTitle(tokens.accessToken, title.npCommunicationId, title.npServiceName),
                ]);
                if (definitions.length === 0) return { kind: "none" };

                const earnedById = new Map(earned.map((t) => [t.trophyId, t]));
                return {
                    kind: "achievements",
                    title: title.trophyTitleName,
                    coverImageUrl: title.trophyTitleIconUrl,
                    // The trophy list's platforms, e.g. "PS3,PSVITA" (see
                    // gameMatcher.ts for how legacy-only lists are treated).
                    consoleVariant: title.trophyTitlePlatform,
                    achievements: definitions.map((trophy) => {
                        const status = earnedById.get(trophy.trophyId);
                        const unlocked = Boolean(status?.earned);
                        return {
                            id: String(trophy.trophyId),
                            name: trophy.trophyName ?? "Hidden trophy",
                            description: trophy.trophyDetail,
                            rarity: status?.trophyEarnedRate ? Number(status.trophyEarnedRate) : undefined,
                            nativeTier: { tier: trophy.trophyType, tierSource: "psn_native" },
                            iconUrl: trophy.trophyIconUrl,
                            unlocked,
                            unlockedAt: unlocked && status?.earnedDateTime ? new Date(status.earnedDateTime) : null,
                        };
                    }),
                };
            },
        };
    },
};
