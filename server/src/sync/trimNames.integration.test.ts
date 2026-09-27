import { beforeAll, afterAll, describe, expect, it } from "vitest";

const integrationEnabled = process.env.INTEGRATION_TESTS === "true";
const integration = integrationEnabled ? describe : describe.skip;

const NBSP = String.fromCharCode(160);

integration("padded titles and achievement names (#364)", () => {
    let pool: import("pg").Pool;
    let canonicalStore: typeof import("./canonicalStore");
    let migrate: typeof import("../db/migrate");

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for integration tests");
        ({ pool } = await import("../db"));
        canonicalStore = await import("./canonicalStore");
        migrate = await import("../db/migrate");
        await pool.query("truncate table users, games, canonical_achievements cascade");
    });

    afterAll(async () => {
        await pool?.end();
    });

    it("stores the trimmed title and name, and keeps the platform's raw ones", async () => {
        const gameId = await canonicalStore.getOrCreateCanonicalGame("psn", "flower", " Flower\n");
        const linkId = await canonicalStore.getOrCreateAchievementLink(gameId, "psn", "flower", "1", `\tBeginning${NBSP}`, undefined, 10);

        const game = await pool.query(
            "select g.title, gpl.platform_title from games g join game_platform_links gpl on gpl.game_id = g.id where g.id = $1",
            [gameId]
        );
        expect(game.rows[0]).toEqual({ title: "Flower", platform_title: " Flower\n" });
        const achievement = await pool.query(
            `select ca.name, apl.platform_name from achievement_platform_links apl
             join canonical_achievements ca on ca.id = apl.canonical_achievement_id where apl.id = $1`,
            [linkId]
        );
        expect(achievement.rows[0]).toEqual({ name: "Beginning", platform_name: `\tBeginning${NBSP}` });
    });

    it("trims rows stored before the fix when the schema is applied", async () => {
        const gameId = await canonicalStore.getOrCreateCanonicalGame("steam", "old", "Old Game");
        const linkId = await canonicalStore.getOrCreateAchievementLink(gameId, "steam", "old", "1", "Old Name", undefined, 10);
        await pool.query("update games set title = $1 where id = $2", [`Uncharted 2${NBSP} `, gameId]);
        await pool.query(
            "update canonical_achievements set name = $1 where id = (select canonical_achievement_id from achievement_platform_links where id = $2)",
            [" Old Name\t", linkId]
        );

        await migrate.applySchema();

        expect((await pool.query("select title from games where id = $1", [gameId])).rows[0].title).toBe("Uncharted 2");
        const name = await pool.query(
            "select ca.name from achievement_platform_links apl join canonical_achievements ca on ca.id = apl.canonical_achievement_id where apl.id = $1",
            [linkId]
        );
        expect(name.rows[0].name).toBe("Old Name");
    });
});
