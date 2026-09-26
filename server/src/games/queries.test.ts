import { describe, expect, it, vi, beforeEach } from "vitest";

// getGamesForUser/getFunStats issue several distinct pool.query calls in
// sequence (games list, rarest achievement, busiest day, ...). Rather than
// pattern-match on SQL text, queueQueryResults lets each test line up
// exactly the rows each call in that sequence should return, in order.
const queryMock = vi.fn();
vi.mock("../db", () => ({ pool: { query: (...args: unknown[]) => queryMock(...args) } }));

function queueQueryResults(...rowsPerCall: unknown[][]) {
    for (const rows of rowsPerCall) {
        queryMock.mockImplementationOnce(async () => ({ rows }));
    }
}

// One raw games-list row as pool.query would return it (numeric aggregates
// come back as strings from node-postgres, hence the string counts).
function gameRow(overrides: Partial<Record<string, unknown>> = {}) {
    return {
        id: "game-1",
        title: "Some Game",
        cover_image_url: null,
        platforms: ["steam"],
        console_variants: null,
        total_achievements: "10",
        unlocked_achievements: "10",
        points_earned: "150",
        platinum_unlocked: "0",
        gold_unlocked: "2",
        silver_unlocked: "3",
        bronze_unlocked: "5",
        ...overrides,
    };
}

beforeEach(() => {
    queryMock.mockReset();
});

describe("getGamesForUser", () => {
    it("awards a synthetic platinum for a 100%-complete non-PSN game with no real platinum", async () => {
        const { getGamesForUser } = await import("./queries");
        queueQueryResults([gameRow()]);

        const [game] = await getGamesForUser("user-1");

        expect(game.platinum_synthetic).toBe(true);
        expect(game.platinum_unlocked).toBe(1);
        expect(game.points_earned).toBe(150 + 300); // TIER_POINTS.platinum
    });

    it("does not double-award a game that already has a real PSN platinum", async () => {
        const { getGamesForUser } = await import("./queries");
        queueQueryResults([gameRow({ platinum_unlocked: "1", points_earned: "450" })]);

        const [game] = await getGamesForUser("user-1");

        expect(game.platinum_synthetic).toBe(false);
        expect(game.platinum_unlocked).toBe(1); // untouched - real platinum, no bonus applied
        expect(game.points_earned).toBe(450); // untouched
    });

    it("does not award a platinum for a game that isn't 100% complete", async () => {
        const { getGamesForUser } = await import("./queries");
        queueQueryResults([gameRow({ unlocked_achievements: "9" })]);

        const [game] = await getGamesForUser("user-1");

        expect(game.platinum_synthetic).toBe(false);
        expect(game.platinum_unlocked).toBe(0);
    });

    it("returns achievement counts as numbers, not node-postgres strings (#270)", async () => {
        const { getGamesForUser } = await import("./queries");
        queueQueryResults([gameRow({ unlocked_achievements: "9", total_achievements: "10" })]);

        const [game] = await getGamesForUser("user-1");

        expect(game.unlocked_achievements).toBe(9);
        expect(game.total_achievements).toBe(10);
        expect(game.unlocked_achievements < game.total_achievements).toBe(true);
    });
});

describe("getFunStats", () => {
    it("counts synthetic completion platinums alongside real ones in totalPlatinums, without double-counting", async () => {
        const { getFunStats } = await import("./queries");
        queueQueryResults(
            [], // rarest
            [], // busiestPointsDay
            [], // busiestUnlockDay
            [], // oldest
            [{ unlocked_at: "2026-01-01T00:00:00Z" }], // real platinums: one row from getFunStats' own query
            [{ count: "0" }], // golds
            [{ count: "0" }], // silvers
            [{ count: "0" }], // bronzes
            [gameRow({ id: "game-real-plat", platinum_unlocked: "1" }), gameRow({ id: "game-synthetic-plat" })] // getGamesForUser's underlying query
        );

        const stats = await getFunStats("user-1");

        // One real platinum (from the platinums query) + one synthetic
        // completion platinum (the second game, 100% with no real platinum).
        expect(stats.totalPlatinums).toBe(2);
        expect(stats.fullyCompletedGames).toBe(2);
    });
});
