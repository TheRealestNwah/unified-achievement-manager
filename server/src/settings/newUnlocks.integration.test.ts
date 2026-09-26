import { beforeAll, afterAll, describe, expect, it } from "vitest";

const integrationEnabled = process.env.INTEGRATION_TESTS === "true";
const integration = integrationEnabled ? describe : describe.skip;

integration("getNewUnlocksSince (#250)", () => {
    let pool: import("pg").Pool;
    let canonicalStore: typeof import("../sync/canonicalStore");
    let getNewUnlocksSince: typeof import("./newUnlocks").getNewUnlocksSince;
    let userId: string;
    let accountId: string;

    async function unlock(gameId: string, n: number, tier: string, unlockedAt: string) {
        const linkId = await canonicalStore.getOrCreateAchievementLink(gameId, "steam", `new-unlocks-${gameId}`, `ach-${n}`, `Achievement ${n}`, undefined, undefined, {
            tier,
            tierSource: "psn_native",
        });
        await canonicalStore.recordUnlock(accountId, linkId, new Date(unlockedAt));
    }

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for integration tests");
        ({ pool } = await import("../db"));
        canonicalStore = await import("../sync/canonicalStore");
        ({ getNewUnlocksSince } = await import("./newUnlocks"));
        await pool.query("truncate table users, games, canonical_achievements cascade");
        userId = (await pool.query("insert into users (username) values ('notify-user') returning id")).rows[0].id;
        accountId = (
            await pool.query(
                `insert into user_platform_accounts (user_id, platform_id, platform_account_id, display_name)
                 values ($1, 'steam', 'notify-steam', 'Notify') returning id`,
                [userId]
            )
        ).rows[0].id;
    });

    afterAll(async () => {
        await pool?.end();
    });

    it("reports unlocks by when they were recorded, not earned, and skips excluded games", async () => {
        const game = await canonicalStore.getOrCreateCanonicalGame("steam", "new-unlocks-a", "Game A");
        const excludedGame = await canonicalStore.getOrCreateCanonicalGame("steam", "new-unlocks-b", "Game B");
        await unlock(game, 1, "bronze", "2015-01-01T00:00:00Z");
        const cursor = (await getNewUnlocksSince(new Date(0).toISOString())).cursor;

        // Earned years ago, but new to the app - still counts as new.
        await unlock(game, 2, "platinum", "2016-06-01T00:00:00Z");
        await unlock(game, 3, "gold", "2020-01-01T00:00:00Z");
        await unlock(excludedGame, 4, "gold", "2020-01-01T00:00:00Z");
        await pool.query("insert into user_game_visibility (user_id, game_id, mode) values ($1, $2, 'excluded')", [userId, excludedGame]);

        const feed = await getNewUnlocksSince(cursor);
        expect(feed.total).toBe(2);
        expect(feed.unlocks.map((u) => u.name).sort()).toEqual(["Achievement 2", "Achievement 3"]);
        expect(feed.platinums).toEqual([{ name: "Achievement 2", game_title: "Game A" }]);

        const after = await getNewUnlocksSince(feed.cursor);
        expect(after.total).toBe(0);
        expect(after.cursor).toBe(feed.cursor);
    });
});
