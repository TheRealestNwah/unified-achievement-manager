import { beforeAll, afterAll, describe, expect, it } from "vitest";

const integrationEnabled = process.env.INTEGRATION_TESTS === "true";
const integration = integrationEnabled ? describe : describe.skip;

integration("matchGames' merge counts (#484)", () => {
    let pool: import("pg").Pool;
    let canonicalStore: typeof import("../sync/canonicalStore");
    let gameMatcher: typeof import("./gameMatcher");

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for integration tests");
        ({ pool } = await import("../db"));
        canonicalStore = await import("../sync/canonicalStore");
        gameMatcher = await import("./gameMatcher");
        await pool.query("truncate table users, games, canonical_achievements cascade");
    });

    afterAll(async () => {
        await pool?.end();
    });

    it("doesn't count a same-title group as merged when its only pair was rejected", async () => {
        const steam = await canonicalStore.getOrCreateCanonicalGame("steam", "counts-app", "Counted Game");
        const gog = await canonicalStore.getOrCreateCanonicalGame("gog", "counts-gog", "Counted Game");
        const [first, second] = [steam, gog].sort();
        await pool.query(
            `insert into game_merge_candidates (game_a_id, game_b_id, confidence, reason, status)
             values ($1, $2, 0.99, 'exact-title', 'rejected')`,
            [first, second]
        );

        expect(await gameMatcher.matchGames()).toMatchObject({ groupsMerged: 0, gamesRemoved: 0 });
        expect((await pool.query("select count(*)::int as n from games where id in ($1, $2)", [steam, gog])).rows[0].n).toBe(2);

        await pool.query("delete from game_merge_candidates");
        expect(await gameMatcher.matchGames()).toMatchObject({ groupsMerged: 1, gamesRemoved: 1 });
    });
});
