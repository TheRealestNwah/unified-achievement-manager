import { beforeAll, afterAll, describe, expect, it } from "vitest";

const integrationEnabled = process.env.INTEGRATION_TESTS === "true";
const integration = integrationEnabled ? describe : describe.skip;

integration("bulk game-merge review (#293)", () => {
    let pool: import("pg").Pool;
    let canonicalStore: typeof import("../sync/canonicalStore");
    let gameReview: typeof import("./gameReview");

    async function candidate(a: string, b: string): Promise<string> {
        const result = await pool.query(
            "insert into game_merge_candidates (game_a_id, game_b_id, confidence, reason) values ($1, $2, 0.9, 'near-title-match') returning id",
            [a, b]
        );
        return result.rows[0].id;
    }

    async function statusOf(id: string): Promise<string | undefined> {
        return (await pool.query("select status from game_merge_candidates where id = $1", [id])).rows[0]?.status;
    }

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for integration tests");
        ({ pool } = await import("../db"));
        canonicalStore = await import("../sync/canonicalStore");
        gameReview = await import("./gameReview");
        await pool.query("truncate table users, games, canonical_achievements cascade");
    });

    afterAll(async () => {
        await pool?.end();
    });

    it("rejects a batch, reopens one, confirms it, and skips resolved ones", async () => {
        const a = await canonicalStore.getOrCreateCanonicalGame("steam", "bulk-merge-a", "Bulk Merge");
        const b = await canonicalStore.getOrCreateCanonicalGame("xbox", "bulk-merge-b", "Bulk Merge!");
        const c = await canonicalStore.getOrCreateCanonicalGame("steam", "bulk-merge-c", "Other Game");
        const d = await canonicalStore.getOrCreateCanonicalGame("xbox", "bulk-merge-d", "Other Game?");
        const first = await candidate(a, b);
        const second = await candidate(c, d);

        expect(await gameReview.resolveGameReviewBatch("merge", [first, second], "reject")).toEqual({ resolved: 2, skipped: 0, failed: 0 });
        expect(await statusOf(first)).toBe("rejected");

        expect(await gameReview.reopenGameReviewCandidate("merge", first)).toBe(true);
        expect(await statusOf(first)).toBe("pending");

        expect(await gameReview.resolveGameReviewBatch("merge", [first, second], "confirm")).toEqual({ resolved: 1, skipped: 1, failed: 0 });
        const links = await pool.query("select platform_id from game_platform_links where game_id = $1 order by platform_id", [a]);
        expect(links.rows.map((r) => r.platform_id)).toEqual(["steam", "xbox"]);
        expect(await statusOf(second)).toBe("rejected");
    });
});
