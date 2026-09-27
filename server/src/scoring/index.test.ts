import { describe, expect, it, vi, beforeEach } from "vitest";

const queryMock = vi.fn();
vi.mock("../db", () => ({ pool: { query: (...args: unknown[]) => queryMock(...args) } }));

const getGameCompletionCountsForUserMock = vi.fn();
vi.mock("../games/queries", () => ({
    getGameCompletionCountsForUser: (...args: unknown[]) => getGameCompletionCountsForUserMock(...args),
}));

function queueQueryResults(...rowsPerCall: unknown[][]) {
    for (const rows of rowsPerCall) {
        queryMock.mockImplementationOnce(async () => ({ rows }));
    }
}

beforeEach(() => {
    queryMock.mockReset();
    getGameCompletionCountsForUserMock.mockReset();
});

describe("recomputeUserScore", () => {
    it("adds a synthetic completion-platinum bonus on top of real achievement points", async () => {
        const { recomputeUserScore } = await import("./index");

        getGameCompletionCountsForUserMock.mockResolvedValue([
            { totalAchievements: 10, unlockedAchievements: 10, platinumUnlocked: 0 }, // qualifies: +300
            { totalAchievements: 10, unlockedAchievements: 5, platinumUnlocked: 0 }, // not complete
            { totalAchievements: 10, unlockedAchievements: 10, platinumUnlocked: 1 }, // already real platinum
        ]);

        queueQueryResults(
            [{ total: "500" }], // real achievement points sum
            [{ level: 2 }], // level lookup (based on totalPoints, but our mock doesn't recheck the arg)
            [], // upsert into user_scores (no rows needed)
            [{ points_required: 400 }], // current level threshold
            [{ points_required: 1000 }] // next level threshold
        );

        const score = await recomputeUserScore("user-1");

        // 500 real points + 300 for the single qualifying synthetic platinum.
        expect(score.totalPoints).toBe(800);

        // The level lookup and the user_scores upsert must both use the
        // combined total (points included the bonus), not just the raw
        // achievement sum - otherwise the synthetic platinum wouldn't
        // actually affect level/points as the issue requires.
        const levelCall = queryMock.mock.calls[1];
        expect(levelCall[1]).toEqual([800]);
        const upsertCall = queryMock.mock.calls[2];
        expect(upsertCall[1]).toEqual(["user-1", 800, 2]);
    });

    it("does not change scoring when no game qualifies for a synthetic platinum", async () => {
        const { recomputeUserScore } = await import("./index");

        getGameCompletionCountsForUserMock.mockResolvedValue([
            { totalAchievements: 10, unlockedAchievements: 10, platinumUnlocked: 1 }, // real platinum already
            { totalAchievements: 10, unlockedAchievements: 3, platinumUnlocked: 0 }, // incomplete
        ]);

        queueQueryResults(
            [{ total: "250" }],
            [{ level: 1 }],
            [],
            [{ points_required: 0 }],
            [{ points_required: 400 }]
        );

        const score = await recomputeUserScore("user-1");
        expect(score.totalPoints).toBe(250);
    });

    it("excludes a user-excluded game's points from the achievement-points sum (see #192)", async () => {
        const { recomputeUserScore } = await import("./index");

        getGameCompletionCountsForUserMock.mockResolvedValue([]);
        queueQueryResults([{ total: "100" }], [{ level: 1 }], [], [{ points_required: 0 }], [{ points_required: 400 }]);

        await recomputeUserScore("user-1");

        const pointsSumCall = queryMock.mock.calls[0];
        expect(pointsSumCall[0]).toContain("user_game_visibility");
        expect(pointsSumCall[0]).toContain("mode = 'excluded'");
    });
});

describe("recomputeAllUserScores", () => {
    it("recomputes and stores every user's score (#356)", async () => {
        const { recomputeAllUserScores } = await import("./index");
        getGameCompletionCountsForUserMock.mockResolvedValue([]);
        queueQueryResults(
            [{ id: "user-1" }, { id: "user-2" }],
            ...[1, 2].flatMap(() => [[{ total: "100" }], [{ level: 1 }], [], [{ points_required: 0 }], [{ points_required: 500 }]])
        );

        await recomputeAllUserScores();

        const upserts = queryMock.mock.calls.filter(([sql]) => String(sql).includes("insert into user_scores"));
        expect(upserts.map(([, params]) => (params as unknown[])[0])).toEqual(["user-1", "user-2"]);
    });
});
