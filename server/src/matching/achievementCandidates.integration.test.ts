import { beforeAll, afterAll, describe, expect, it } from "vitest";

const integrationEnabled = process.env.INTEGRATION_TESTS === "true";
const integration = integrationEnabled ? describe : describe.skip;

integration("bulk achievement-candidate review (#252)", () => {
    let pool: import("pg").Pool;
    let canonicalStore: typeof import("../sync/canonicalStore");
    let matcher: typeof import("./achievementMatcher");
    let gameId: string;

    // One Steam and one Xbox achievement in the same game, plus a pending
    // candidate proposing they're the same - returns the candidate's id.
    async function candidatePair(n: number): Promise<string> {
        const steamLink = await canonicalStore.getOrCreateAchievementLink(gameId, "steam", "bulk-app", `steam-${n}`, `Steam ${n}`, undefined, undefined);
        const xboxLink = await canonicalStore.getOrCreateAchievementLink(gameId, "xbox", "bulk-title", `xbox-${n}`, `Xbox ${n}`, undefined, undefined);
        const target = await pool.query("select canonical_achievement_id from achievement_platform_links where id = $1", [steamLink]);
        const candidate = await pool.query(
            `insert into achievement_match_candidates (achievement_platform_link_id, candidate_canonical_achievement_id, confidence)
             values ($1, $2, 0.9) returning id`,
            [xboxLink, target.rows[0].canonical_achievement_id]
        );
        return candidate.rows[0].id;
    }

    async function statusOf(id: string): Promise<string> {
        return (await pool.query("select status from achievement_match_candidates where id = $1", [id])).rows[0].status;
    }

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for integration tests");
        ({ pool } = await import("../db"));
        canonicalStore = await import("../sync/canonicalStore");
        matcher = await import("./achievementMatcher");
        await pool.query("truncate table users, games, canonical_achievements cascade");
        gameId = await canonicalStore.getOrCreateCanonicalGame("steam", "bulk-app", "Bulk Game");
    });

    afterAll(async () => {
        await pool?.end();
    });

    it("rejects a batch, reopens one, then confirms it and skips ones already resolved", async () => {
        const [a, b] = [await candidatePair(1), await candidatePair(2)];

        expect(await matcher.resolveMatchCandidates([a, b], "reject")).toEqual({ resolved: 2, skipped: 0 });
        expect(await statusOf(a)).toBe("rejected");

        expect(await matcher.reopenMatchCandidate(a)).toBe(true);
        expect(await statusOf(a)).toBe("pending");

        expect(await matcher.resolveMatchCandidates([a, b], "confirm")).toEqual({ resolved: 1, skipped: 1 });
        expect(await statusOf(a)).toBe("confirmed");
        expect(await statusOf(b)).toBe("rejected");

        // Confirmed means merged - it can't be reopened.
        expect(await matcher.reopenMatchCandidate(a)).toBe(false);
    });
});
