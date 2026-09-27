import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import type { XboxAchievement, XboxTitleSummary } from "./client";

const integrationEnabled = process.env.INTEGRATION_TESTS === "true";
const integration = integrationEnabled ? describe : describe.skip;

// OpenXBL is stubbed - this is about which titles sync asks it for (#384).
const getTitles = vi.fn<(apiKey: string) => Promise<XboxTitleSummary[]>>();
const getAchievementsForTitle = vi.fn<(apiKey: string, titleId: string) => Promise<XboxAchievement[]>>();
const getX360AchievementsForTitle = vi.fn<(apiKey: string, xuid: string, titleId: string) => Promise<XboxAchievement[]>>();
vi.mock("./client", () => ({
    getTitles: (...args: [string]) => getTitles(...args),
    getAchievementsForTitle: (...args: [string, string]) => getAchievementsForTitle(...args),
    getX360AchievementsForTitle: (...args: [string, string, string]) => getX360AchievementsForTitle(...args),
}));

function title(titleId: string, progress: string | undefined): XboxTitleSummary {
    return { titleId, name: `Sync State Game ${titleId}`, totalAchievements: 1, progress };
}

const unlocked: XboxAchievement = {
    id: "a1",
    name: "First Steps",
    description: "Do the thing",
    isUnlocked: true,
    timeUnlocked: "2026-09-01T10:00:00Z",
    gamerscore: 10,
};

integration("Xbox sync skips titles whose progress hasn't changed (#384)", () => {
    let pool: import("pg").Pool;
    let syncXboxAccount: typeof import("./sync").syncXboxAccount;
    let accountId: string;

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for integration tests");
        ({ pool } = await import("../db"));
        ({ syncXboxAccount } = await import("./sync"));
        await pool.query("truncate table users cascade");
        const userId = (await pool.query("insert into users (username) values ('xbox-sync-state-user') returning id")).rows[0].id;
        accountId = (
            await pool.query(
                `insert into user_platform_accounts (user_id, platform_id, platform_account_id, display_name)
                 values ($1, 'xbox', 'xbox-sync-state', 'Xbox Sync State') returning id`,
                [userId]
            )
        ).rows[0].id;
    });

    beforeEach(() => {
        getTitles.mockReset();
        getAchievementsForTitle.mockReset().mockResolvedValue([unlocked]);
        getX360AchievementsForTitle.mockReset().mockResolvedValue([]);
    });

    afterAll(async () => {
        await pool?.end();
    });

    it("fetches a title once, then again only when its progress moves", async () => {
        getTitles.mockResolvedValue([title("100", "1|1|10|t1"), title("200", undefined)]);
        await syncXboxAccount(accountId, "key", "xuid");
        expect(getAchievementsForTitle.mock.calls.map((c) => c[1])).toEqual(["100", "200"]);

        getAchievementsForTitle.mockClear();
        await syncXboxAccount(accountId, "key", "xuid");
        // 100 is unchanged; 200 has no progress fields to compare, so it's
        // always fetched.
        expect(getAchievementsForTitle.mock.calls.map((c) => c[1])).toEqual(["200"]);

        getAchievementsForTitle.mockClear();
        getTitles.mockResolvedValue([title("100", "1|1|10|t2"), title("200", undefined)]);
        await syncXboxAccount(accountId, "key", "xuid");
        expect(getAchievementsForTitle.mock.calls.map((c) => c[1])).toEqual(["100", "200"]);
    });

    it("re-fetches a title whose sync was cut off, but not the ones before it", async () => {
        getTitles.mockResolvedValue([title("300", "1|1|10|t1"), title("400", "1|1|10|t1")]);
        getAchievementsForTitle.mockImplementation(async (_key, titleId) => {
            if (titleId === "400") throw new Error("OpenXBL /v2/achievements/title/400 failed: 429");
            return [unlocked];
        });
        await expect(syncXboxAccount(accountId, "key", "xuid")).rejects.toThrow("429");

        getAchievementsForTitle.mockReset().mockResolvedValue([unlocked]);
        await syncXboxAccount(accountId, "key", "xuid");
        expect(getAchievementsForTitle.mock.calls.map((c) => c[1])).toEqual(["400"]);
    });

    it("remembers a title that turned out to have no achievements on either endpoint", async () => {
        getTitles.mockResolvedValue([title("500", "1|0|0|t1")]);
        getAchievementsForTitle.mockResolvedValue([]);
        await syncXboxAccount(accountId, "key", "xuid");
        expect(getX360AchievementsForTitle).toHaveBeenCalledTimes(1);

        getAchievementsForTitle.mockClear();
        getX360AchievementsForTitle.mockClear();
        await syncXboxAccount(accountId, "key", "xuid");
        expect(getAchievementsForTitle).not.toHaveBeenCalledWith("key", "500");
        expect(getX360AchievementsForTitle).not.toHaveBeenCalled();
    });
});
