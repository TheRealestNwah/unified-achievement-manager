import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import type { GameAchievementSchema, OwnedGame, PlayerAchievement } from "./client";

const integrationEnabled = process.env.INTEGRATION_TESTS === "true";
const integration = integrationEnabled ? describe : describe.skip;

// Steam is stubbed - this is about when a game counts as synced (#385).
const getOwnedGames = vi.fn<(steamId: string) => Promise<OwnedGame[]>>();
const getSchemaForGame = vi.fn<(appId: number) => Promise<GameAchievementSchema[]>>();
const getPlayerAchievements = vi.fn<(appId: number, steamId: string) => Promise<PlayerAchievement[]>>();
const getGlobalAchievementPercentages = vi.fn<(appId: number) => Promise<Map<string, number>>>();
vi.mock("./client", () => ({
    getOwnedGames: (...args: [string]) => getOwnedGames(...args),
    getSchemaForGame: (...args: [number]) => getSchemaForGame(...args),
    getPlayerAchievements: (...args: [number, string]) => getPlayerAchievements(...args),
    getGlobalAchievementPercentages: (...args: [number]) => getGlobalAchievementPercentages(...args),
}));

const APPID = 9_385_001;

integration("Steam sync marks a game synced only once it's fully recorded (#385)", () => {
    let pool: import("pg").Pool;
    let syncSteamAccount: typeof import("./sync").syncSteamAccount;
    let accountId: string;

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for integration tests");
        ({ pool } = await import("../db"));
        ({ syncSteamAccount } = await import("./sync"));
        await pool.query("truncate table users cascade");
        await pool.query("delete from steam_global_rarity_cache where appid = $1", [APPID]);
        const userId = (await pool.query("insert into users (username) values ('steam-sync-state-user') returning id")).rows[0].id;
        accountId = (
            await pool.query(
                `insert into user_platform_accounts (user_id, platform_id, platform_account_id, display_name)
                 values ($1, 'steam', 'steam-sync-state', 'Steam Sync State') returning id`,
                [userId]
            )
        ).rows[0].id;
    });

    afterAll(async () => {
        await pool?.query("delete from steam_global_rarity_cache where appid = $1", [APPID]);
        await pool?.end();
    });

    it("fetches a game again after its sync failed partway", async () => {
        getOwnedGames.mockResolvedValue([{ appid: APPID, name: "Sync State Game", playtime_forever: 60, rtime_last_played: 1_700_000_000 }]);
        getSchemaForGame.mockResolvedValue([{ name: "ACH_1", displayName: "First Steps", description: "Do the thing" }]);
        getGlobalAchievementPercentages.mockResolvedValue(new Map([["ACH_1", 40]]));
        getPlayerAchievements.mockRejectedValueOnce(new Error("Steam said 429"));
        await expect(syncSteamAccount(accountId, "steam-id")).rejects.toThrow("429");

        getPlayerAchievements.mockResolvedValue([{ apiname: "ACH_1", achieved: 1, unlocktime: 1_700_000_000 }]);
        const summary = await syncSteamAccount(accountId, "steam-id");
        expect(getPlayerAchievements).toHaveBeenCalledTimes(2);
        expect(summary.achievementsUnlocked).toBe(1);

        // Now it's recorded, an unchanged game is skipped as before.
        await syncSteamAccount(accountId, "steam-id");
        expect(getPlayerAchievements).toHaveBeenCalledTimes(2);
    });
});
