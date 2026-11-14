import { PlatformAdapter } from "../sync/platformAdapter";
import { getOwnedGames, getPlayerAchievements, getSchemaForGame, OwnedGame as SteamOwnedGame } from "./client";
import { getCachedGlobalPercentages } from "./globalRarityCache";

// Steam's CDN serves box art at a predictable per-appid URL - no API call
// needed, confirmed live (200) against a real appid. The library capsule
// (portrait 600x900, the same shape modern Steam's own library grid uses and
// what SteamGridDB's default grid images match) rather than the landscape
// header capsule - a landscape image cropped into the dashboard's portrait
// cover box just shows a cropped sliver of the middle.
export function steamCoverUrl(appid: number): string {
    return `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/library_600x900.jpg`;
}

// The change marker: total playtime and last-played time. Neither can change
// without the user actually playing the game, and achievement unlocks only
// ever happen during play - so if both are unchanged since last sync, nothing
// about this game (including a from-scratch "does it have achievements"
// check) needs re-fetching. Both rather than just playtime_forever closes the
// edge case of an achievement unlocking within the same whole-minute window
// as the previous sync's playtime reading. Verified live against a real
// 494-game library that both fields are present and well-formed (see PR #21's
// test plan).
//
// Trade-off: this also means a revoked achievement (see #57) only gets caught
// the next time this game is actually played - a stale unlock on a game the
// user hasn't touched since stays stale until they do. Accepted rather than
// dropping this skip entirely, which would mean re-fetching every game's
// achievements on every sync.
export function steamChangeMarker(playtimeForever: number, rtimeLastPlayed: number): string {
    return `${playtimeForever}:${rtimeLastPlayed}`;
}

export const steamAdapter: PlatformAdapter<SteamOwnedGame> = {
    platformId: "steam",

    async connect(account) {
        // The app's own Steam Web API key (see config); the account is just a SteamID.
        const steamId = account.platformAccountId;

        return {
            async listOwnedGames() {
                const games = await getOwnedGames(steamId);
                return games.map((game) => ({
                    platformGameId: String(game.appid),
                    changeMarker: steamChangeMarker(game.playtime_forever, game.rtime_last_played),
                    details: game,
                }));
            },

            async fetchAchievementList(game) {
                const appid = Number(game.platformGameId);
                const schema = await getSchemaForGame(appid);
                if (schema.length === 0) return { kind: "none" };

                const [playerAchievements, globalPercentages] = await Promise.all([
                    getPlayerAchievements(appid, steamId),
                    getCachedGlobalPercentages(appid),
                ]);
                const unlockByName = new Map(playerAchievements.map((a) => [a.apiname, a]));

                return {
                    kind: "achievements",
                    title: game.details.name ?? game.platformGameId,
                    coverImageUrl: steamCoverUrl(appid),
                    achievements: schema.map((achievement) => {
                        const unlock = unlockByName.get(achievement.name);
                        const unlocked = Boolean(unlock?.achieved);
                        return {
                            id: achievement.name,
                            name: achievement.displayName,
                            description: achievement.description,
                            rarity: globalPercentages.get(achievement.name),
                            iconUrl: achievement.iconUrl,
                            unlocked,
                            // Steam reports 0 for some old unlocks (see #423).
                            unlockedAt: unlocked && unlock?.unlocktime ? new Date(unlock.unlocktime * 1000) : null,
                        };
                    }),
                };
            },
        };
    },
};
