import { beforeAll, afterAll, describe, expect, it } from "vitest";

const integrationEnabled = process.env.INTEGRATION_TESTS === "true";
const integration = integrationEnabled ? describe : describe.skip;

integration("unlocks with no known date (#423)", () => {
    let pool: import("pg").Pool;
    let canonicalStore: typeof import("./canonicalStore");
    let queries: typeof import("../games/queries");
    let repairUnknownUnlockDates: typeof import("../db/repairUnlockDates").repairUnknownUnlockDates;
    let userId: string;
    let accountId: string;

    async function link(game: string, n: number) {
        const gameId = await canonicalStore.getOrCreateCanonicalGame("xbox", game, `Game ${game}`);
        await canonicalStore.recordOwnership(accountId, gameId);
        return canonicalStore.getOrCreateAchievementLink(gameId, "xbox", game, `ach-${n}`, `${game} achievement ${n}`, undefined, undefined);
    }

    async function unlockedAt(linkId: string): Promise<Date | null> {
        const row = await pool.query("select unlocked_at from user_achievement_unlocks where achievement_platform_link_id = $1", [linkId]);
        return row.rows[0].unlocked_at;
    }

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for integration tests");
        ({ pool } = await import("../db"));
        canonicalStore = await import("./canonicalStore");
        queries = await import("../games/queries");
        ({ repairUnknownUnlockDates } = await import("../db/repairUnlockDates"));
        const { applySchema } = await import("../db/migrate");
        await applySchema();
        await pool.query("truncate table users, games, canonical_achievements cascade");
        await pool.query("delete from app_settings where key = 'repaired_unknown_unlock_dates'");
        userId = (await pool.query("insert into users (username) values ('dates-user') returning id")).rows[0].id;
        accountId = (
            await pool.query(
                `insert into user_platform_accounts (user_id, platform_id, platform_account_id, display_name)
                 values ($1, 'xbox', 'dates-xbox', 'Dates') returning id`,
                [userId]
            )
        ).rows[0].id;
    });

    afterAll(async () => {
        await pool?.end();
    });

    it("records an unknown date as unknown, fills it in later, and never overwrites a real one", async () => {
        const undated = await link("undated", 1);
        expect(await canonicalStore.recordUnlock(accountId, undated, null)).toBe(true);
        expect(await unlockedAt(undated)).toBeNull();

        // Not a new unlock the second time, even though the date gets filled in.
        expect(await canonicalStore.recordUnlock(accountId, undated, new Date("2011-03-04T05:06:07Z"))).toBe(false);
        expect((await unlockedAt(undated))?.toISOString()).toBe("2011-03-04T05:06:07.000Z");

        expect(await canonicalStore.recordUnlock(accountId, undated, null)).toBe(false);
        expect((await unlockedAt(undated))?.toISOString()).toBe("2011-03-04T05:06:07.000Z");
    });

    it("leaves undated unlocks out of Recent activity but still counts them", async () => {
        const dated = await link("activity", 1);
        const undated = await link("activity", 2);
        await canonicalStore.recordUnlock(accountId, dated, new Date("2012-01-01T00:00:00Z"));
        await canonicalStore.recordUnlock(accountId, undated, null);

        const activity = await queries.getRecentActivity(userId, 50);
        const names = activity.map((a: { name: string }) => a.name);
        expect(names).toContain("activity achievement 1");
        expect(names).not.toContain("activity achievement 2");

        const game = (await queries.getGamesForUser(userId)).find((g: { title: string }) => g.title === "Game activity");
        expect(Number(game.unlocked_achievements)).toBe(2);
    });

    it("clears sync-time bursts and pre-2000 dates once, leaving real dates alone", async () => {
        // A sync that stamped its own time on unlocks from three games.
        const burst = [await link("burst-a", 1), await link("burst-b", 1), await link("burst-c", 1)];
        for (const [i, linkId] of burst.entries()) {
            await canonicalStore.recordUnlock(accountId, linkId, new Date(Date.UTC(2026, 8, 24, 20, 4, 10 + i)));
        }
        // Several unlocks in one game within seconds is normal play.
        const sameGame = [await link("combo", 1), await link("combo", 2), await link("combo", 3)];
        for (const [i, linkId] of sameGame.entries()) {
            await canonicalStore.recordUnlock(accountId, linkId, new Date(Date.UTC(2020, 0, 1, 12, 0, i)));
        }
        const epoch = await link("steam-zero", 1);
        await canonicalStore.recordUnlock(accountId, epoch, new Date(0));

        expect(await repairUnknownUnlockDates()).toBe(4);
        for (const linkId of [...burst, epoch]) expect(await unlockedAt(linkId)).toBeNull();
        for (const linkId of sameGame) expect(await unlockedAt(linkId)).not.toBeNull();

        // Only ever once per data folder.
        const later = [await link("later-a", 1), await link("later-b", 1), await link("later-c", 1)];
        for (const linkId of later) await canonicalStore.recordUnlock(accountId, linkId, new Date(Date.UTC(2026, 8, 25, 1, 0, 0)));
        expect(await repairUnknownUnlockDates()).toBe(0);
        for (const linkId of later) expect(await unlockedAt(linkId)).not.toBeNull();
    });
});
