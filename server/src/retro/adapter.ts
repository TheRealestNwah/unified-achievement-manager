import { PlatformAdapter } from "../sync/platformAdapter";
import { getGameProgress, getUserGames, RetroGameSummary } from "./client";

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// RetroAchievements' API has no documented hard rate limit, but community
// guidance is to stay well under ~1 request/second - a large library means
// one call per game, so this throttles proactively instead of reacting to a
// ban after the fact (unlike Xbox's client, which retries reactively on a
// real 429 from a service that does document its limits).
export const REQUEST_DELAY_MS = 300;

// RA's DateEarned(Hardcore) is "YYYY-MM-DD HH:MM:SS" in UTC with no timezone
// marker - reformat to a real ISO instant.
export function parseRetroDate(value: string): Date {
    return new Date(`${value.replace(" ", "T")}Z`);
}

export const retroAdapter: PlatformAdapter<RetroGameSummary> = {
    platformId: "retroachievements",

    async connect(account) {
        // The user's own RA username and web API key.
        const username = account.platformAccountId;
        const apiKey = account.accessToken!;

        return {
            async listOwnedGames() {
                return (await getUserGames(username, apiKey)).map((game) => ({ platformGameId: game.gameId, details: game }));
            },

            async fetchAchievementList(game) {
                const achievements = await getGameProgress(username, apiKey, game.platformGameId);
                await sleep(REQUEST_DELAY_MS);
                if (achievements.length === 0) return { kind: "none" };

                const summary = game.details;
                return {
                    kind: "achievements",
                    title: summary.title,
                    coverImageUrl: summary.coverImageUrl,
                    achievements: achievements.map((a) => ({
                        id: a.id,
                        name: a.name,
                        description: a.description,
                        rarity: a.globalUnlockRarity,
                        iconUrl: a.iconUrl,
                        unlocked: a.isUnlocked,
                        unlockedAt: a.isUnlocked && a.unlockedAt ? parseRetroDate(a.unlockedAt) : null,
                    })),
                };
            },
        };
    },
};
