import { PlatformAdapter } from "../sync/platformAdapter";
import { getAchievementsForTitle, getTitles, getX360AchievementsForTitle, XboxTitleSummary } from "./client";

export const xboxAdapter: PlatformAdapter<XboxTitleSummary> = {
    platformId: "xbox",

    async connect(account) {
        // The user's OpenXBL API key.
        const apiKey = account.accessToken!;
        const xuid = account.platformAccountId;

        return {
            async listOwnedGames() {
                return (await getTitles(apiKey)).map((title) => {
                    return {
                        platformGameId: title.titleId,
                        details: title,
                        // Same idea as Steam's playtime marker: a title's
                        // unlocked count, gamerscore, and last-played time
                        // can't all stay put while its unlocks change, so
                        // there's nothing to re-fetch (see #384). A revoked
                        // achievement lowers the count, so #57 still gets
                        // caught. Trade-off, as on Steam: rarity for a title
                        // nobody has played since stays as of the last fetch.
                        // Titles without a progress summary are always fetched.
                        changeMarker: title.progress,
                        hasAchievements: title.totalAchievements !== 0,
                    };
                });
            },

            async fetchAchievementList(game) {
                const title = game.details;
                let achievements = await getAchievementsForTitle(apiKey, title.titleId);
                // Which endpoint actually had data doubles as the only
                // reliable console-generation signal OpenXBL gives us - see
                // #36. The `devices` field on /v2/titles reports backward-
                // compatibility, not origin generation (a classic 360 title
                // playable via compat on newer consoles lists all three), so
                // it can't tell One from Series. This can: only classic 360
                // titles fall through to the legacy endpoint, which is a real,
                // already-verified signal, just not a 3-way split - and it
                // can't tell PC from console at all, since the Xbox app on PC
                // uses the same modern achievements endpoint as Xbox
                // One/Series (see #77). No variant label for that ambiguous
                // case rather than a claim we can't back up.
                let consoleVariant: string | undefined;
                if (achievements.length === 0) {
                    // Classic Xbox 360 titles use a separate legacy achievements
                    // contract - see getX360AchievementsForTitle for what's different.
                    achievements = await getX360AchievementsForTitle(apiKey, xuid, title.titleId);
                    consoleVariant = "Xbox 360";
                }
                if (achievements.length === 0) return { kind: "none" };

                return {
                    kind: "achievements",
                    title: title.name,
                    coverImageUrl: title.coverImageUrl,
                    consoleVariant,
                    achievements: achievements.map((a) => ({
                        id: a.id,
                        name: a.name,
                        description: a.description,
                        rarity: a.rarityPercent,
                        iconUrl: a.iconUrl,
                        unlocked: a.isUnlocked,
                        unlockedAt: a.timeUnlocked ? new Date(a.timeUnlocked) : null,
                    })),
                };
            },
        };
    },
};
