import { beforeAll, afterAll, describe, expect, it } from "vitest";

const integrationEnabled = process.env.INTEGRATION_TESTS === "true";
const integration = integrationEnabled ? describe : describe.skip;

integration("mergeGames keeps each user's settings (#334)", () => {
    let pool: import("pg").Pool;
    let canonicalStore: typeof import("../sync/canonicalStore");
    let mergeGames: typeof import("./gameMatcher").mergeGames;
    let userId: string;
    let otherUserId: string;

    async function visibility(user: string, gameId: string): Promise<string | undefined> {
        return (await pool.query("select mode from user_game_visibility where user_id = $1 and game_id = $2", [user, gameId])).rows[0]?.mode;
    }

    async function coverOverride(user: string, gameId: string): Promise<string | undefined> {
        return (
            await pool.query("select cover_image_url from user_game_cover_overrides where user_id = $1 and game_id = $2", [user, gameId])
        ).rows[0]?.cover_image_url;
    }

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for integration tests");
        ({ pool } = await import("../db"));
        canonicalStore = await import("../sync/canonicalStore");
        ({ mergeGames } = await import("./gameMatcher"));
        await pool.query("truncate table users, games, canonical_achievements cascade");
        userId = (await pool.query("insert into users (username) values ('merge-settings-user') returning id")).rows[0].id;
        otherUserId = (await pool.query("insert into users (username) values ('merge-settings-other') returning id")).rows[0].id;
    });

    afterAll(async () => {
        await pool?.end();
    });

    it("moves the loser's visibility and cover override to the winner", async () => {
        const winner = await canonicalStore.getOrCreateCanonicalGame("steam", "merge-settings-w1", "Merge Settings");
        const loser = await canonicalStore.getOrCreateCanonicalGame("xbox", "merge-settings-l1", "Merge Settings X", "https://example.com/xbox.png");
        await pool.query("insert into user_game_visibility (user_id, game_id, mode) values ($1, $2, 'excluded')", [userId, loser]);
        await pool.query("insert into user_game_cover_overrides (user_id, game_id, cover_image_url) values ($1, $2, 'https://example.com/mine.png')", [
            userId,
            loser,
        ]);

        await mergeGames(winner, loser);

        expect(await visibility(userId, winner)).toBe("excluded");
        expect(await coverOverride(userId, winner)).toBe("https://example.com/mine.png");
        // The winner had no platform cover, so it picks up the loser's.
        const game = await pool.query("select cover_image_url from games where id = $1", [winner]);
        expect(game.rows[0].cover_image_url).toBe("https://example.com/xbox.png");
    });

    it("keeps a setting the user already has on the winner, per user", async () => {
        const winner = await canonicalStore.getOrCreateCanonicalGame("steam", "merge-settings-w2", "Merge Settings Two", "https://example.com/steam.png");
        const loser = await canonicalStore.getOrCreateCanonicalGame("xbox", "merge-settings-l2", "Merge Settings Two X", "https://example.com/xbox2.png");
        await pool.query("insert into user_game_visibility (user_id, game_id, mode) values ($1, $2, 'hidden'), ($1, $3, 'excluded'), ($4, $3, 'hidden')", [
            userId,
            winner,
            loser,
            otherUserId,
        ]);
        await pool.query(
            "insert into user_game_cover_overrides (user_id, game_id, cover_image_url) values ($1, $2, 'https://example.com/keep.png'), ($1, $3, 'https://example.com/drop.png')",
            [userId, winner, loser]
        );

        await mergeGames(winner, loser);

        expect(await visibility(userId, winner)).toBe("hidden");
        expect(await visibility(otherUserId, winner)).toBe("hidden");
        expect(await coverOverride(userId, winner)).toBe("https://example.com/keep.png");
        const game = await pool.query("select cover_image_url from games where id = $1", [winner]);
        expect(game.rows[0].cover_image_url).toBe("https://example.com/steam.png");
    });
});
