import { beforeAll, afterAll, describe, expect, it } from "vitest";

const integrationEnabled = process.env.INTEGRATION_TESTS === "true";
const integration = integrationEnabled ? describe : describe.skip;

integration("getFunStats tier totals", () => {
    let pool: import("pg").Pool;
    let canonicalStore: typeof import("../sync/canonicalStore");
    let getFunStats: typeof import("./queries").getFunStats;
    let userId: string;
    let accountId: string;
    let gameId: string;

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for integration tests");
        ({ pool } = await import("../db"));
        canonicalStore = await import("../sync/canonicalStore");
        ({ getFunStats } = await import("./queries"));

        await pool.query("truncate table users, games, canonical_achievements cascade");

        const user = await pool.query("insert into users (username) values ($1) returning id", ["fun-stats-user"]);
        userId = user.rows[0].id;
        const account = await pool.query(
            `insert into user_platform_accounts
                (user_id, platform_id, platform_account_id, display_name)
             values ($1, 'steam', $2, $3) returning id`,
            [userId, "fun-stats-steam-id", "Fun Stats User"]
        );
        accountId = account.rows[0].id;

        gameId = await canonicalStore.getOrCreateCanonicalGame("steam", "fun-stats-app", "Fun Stats Game");
        await canonicalStore.recordOwnership(accountId, gameId);
    });

    afterAll(async () => {
        await pool?.end();
    });

    it("counts unlocked achievements per tier across the user's library", async () => {
        // Two platinums, one gold, three silvers, zero bronzes - forced via
        // nativeTier so this doesn't depend on the rarity-fallback thresholds.
        const tierPlan: { tier: string; count: number }[] = [
            { tier: "platinum", count: 2 },
            { tier: "gold", count: 1 },
            { tier: "silver", count: 3 },
            { tier: "bronze", count: 0 },
        ];

        let achievementIndex = 0;
        for (const { tier, count } of tierPlan) {
            for (let i = 0; i < count; i++) {
                achievementIndex++;
                const linkId = await canonicalStore.getOrCreateAchievementLink(
                    gameId,
                    "steam",
                    "fun-stats-app",
                    `fun-stats-achievement-${achievementIndex}`,
                    `Achievement ${achievementIndex}`,
                    undefined,
                    undefined,
                    { tier, tierSource: "psn_native" }
                );
                await canonicalStore.recordUnlock(accountId, linkId, new Date(`2026-01-${10 + achievementIndex}T00:00:00Z`));
            }
        }

        const stats = await getFunStats(userId);

        expect(stats.totalPlatinums).toBe(2);
        expect(stats.totalGold).toBe(1);
        expect(stats.totalSilver).toBe(3);
        expect(stats.totalBronze).toBe(0);
    });

    it("keeps a hidden game in the totals, drops an excluded one, and leaves both out of the activity feed (#236)", async () => {
        const { getRecentActivity } = await import("./queries");
        const otherGameId = await canonicalStore.getOrCreateCanonicalGame("steam", "fun-stats-other-app", "Other Game");
        await canonicalStore.recordOwnership(accountId, otherGameId);
        const linkId = await canonicalStore.getOrCreateAchievementLink(
            otherGameId,
            "steam",
            "fun-stats-other-app",
            "fun-stats-other-achievement",
            "Other Achievement",
            undefined,
            undefined,
            { tier: "gold", tierSource: "psn_native" }
        );
        await canonicalStore.recordUnlock(accountId, linkId, new Date("2026-02-01T00:00:00Z"));
        const before = await getFunStats(userId);

        await pool.query(
            "insert into user_game_visibility (user_id, game_id, mode) values ($1, $2, 'hidden')",
            [userId, otherGameId]
        );
        const hidden = await getFunStats(userId);
        expect(hidden.totalGold).toBe(before.totalGold);
        expect(hidden.fullyCompletedGames).toBe(before.fullyCompletedGames);
        expect((await getRecentActivity(userId)).some((a) => a.game_id === otherGameId)).toBe(false);

        await pool.query("update user_game_visibility set mode = 'excluded' where user_id = $1 and game_id = $2", [
            userId,
            otherGameId,
        ]);
        const excluded = await getFunStats(userId);
        expect(excluded.totalGold).toBe(before.totalGold - 1);
        expect(excluded.fullyCompletedGames).toBe(before.fullyCompletedGames - 1);
        expect((await getRecentActivity(userId)).some((a) => a.game_id === otherGameId)).toBe(false);
    });
});
