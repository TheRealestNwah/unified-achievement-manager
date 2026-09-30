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

        expect(await matcher.resolveMatchCandidates([a, b], "reject")).toEqual({ resolved: 2, skipped: 0, conflicted: 0 });
        expect(await statusOf(a)).toBe("rejected");

        expect(await matcher.reopenMatchCandidate(a)).toBe(true);
        expect(await statusOf(a)).toBe("pending");

        expect(await matcher.resolveMatchCandidates([a, b], "confirm")).toEqual({ resolved: 1, skipped: 1, conflicted: 0 });
        expect(await statusOf(a)).toBe("confirmed");
        expect(await statusOf(b)).toBe("rejected");

        // Confirmed means merged - it can't be reopened.
        expect(await matcher.reopenMatchCandidate(a)).toBe(false);
    });

    it("confirms the rest of a batch when one candidate can't be merged, and leaves that one pending (#406)", async () => {
        const [a, b] = [await candidatePair(10), await candidatePair(11)];
        // A second Xbox achievement from the same list, proposed as the same
        // achievement as the one a's Xbox link already merges into.
        const extraXbox = await canonicalStore.getOrCreateAchievementLink(gameId, "xbox", "bulk-title", "xbox-10b", "Xbox 10b", undefined, undefined);
        const aTarget = await pool.query("select candidate_canonical_achievement_id as id from achievement_match_candidates where id = $1", [a]);
        const conflict = (
            await pool.query(
                `insert into achievement_match_candidates (achievement_platform_link_id, candidate_canonical_achievement_id, confidence)
                 values ($1, $2, 0.9) returning id`,
                [extraXbox, aTarget.rows[0].id]
            )
        ).rows[0].id;

        expect(await matcher.resolveMatchCandidates([a, conflict, b], "confirm")).toEqual({ resolved: 2, skipped: 0, conflicted: 1 });
        expect(await statusOf(a)).toBe("confirmed");
        expect(await statusOf(b)).toBe("confirmed");
        expect(await statusOf(conflict)).toBe("pending");
        await expect(matcher.confirmMatchCandidate(conflict)).rejects.toMatchObject({ status: 409 });
    });

    it("records a near-match once however many times matching runs, and keeps it rejected (#345, #480)", async () => {
        const game = await canonicalStore.getOrCreateCanonicalGame("steam", "rerun-app", "Rerun Game");
        await canonicalStore.getOrCreateAchievementLink(game, "steam", "rerun-app", "s1", "TR1 | Codex of Peru", undefined, undefined);
        const xboxLink = await canonicalStore.getOrCreateAchievementLink(game, "xbox", "rerun-title", "x1", "TR Codex of Peru", undefined, undefined);
        const rows = async () =>
            (await pool.query("select id, status from achievement_match_candidates where achievement_platform_link_id = $1", [xboxLink])).rows;

        expect(await matcher.matchAchievementsForGame(game)).toEqual({ merged: 0, candidates: 1 });
        expect(await matcher.matchAchievementsForGame(game)).toEqual({ merged: 0, candidates: 1 });
        const [only, ...rest] = await rows();
        expect(rest).toEqual([]);
        expect(only.status).toBe("pending");

        await matcher.rejectMatchCandidate(only.id);
        // Not waiting for review any more, so not counted as such (#480).
        expect(await matcher.matchAchievementsForGame(game)).toEqual({ merged: 0, candidates: 0 });
        expect(await rows()).toEqual([{ id: only.id, status: "rejected" }]);
    });

    it("merges names that match once Xbox's per-game tag is removed, unless the name is ambiguous (#357)", async () => {
        const game = await canonicalStore.getOrCreateCanonicalGame("steam", "tag-app", "FFX/X-2");
        const steam = ["Mega Strike", "All Together", "Learning!", "Sphere Hunter", "Sphere Hunter"];
        const xbox = ["FFX: Mega Strike", "FFX: All Together", "FFX: Learning!", "FFX: Sphere Hunter", "FFX-2: Sphere Hunter", "FFX-2: Teamwork!", "FFX-2: Just Starting"];
        for (const [i, name] of steam.entries()) await canonicalStore.getOrCreateAchievementLink(game, "steam", "tag-app", `s${i}`, name, undefined, undefined);
        for (const [i, name] of xbox.entries()) await canonicalStore.getOrCreateAchievementLink(game, "xbox", "tag-title", `x${i}`, name, undefined, undefined);

        await matcher.matchAchievementsForGame(game);

        const platformsByName = async (name: string) =>
            (
                await pool.query(
                    `select array_agg(apl.platform_id order by apl.platform_id) as platforms
                     from canonical_achievements ca join achievement_platform_links apl on apl.canonical_achievement_id = ca.id
                     where ca.game_id = $1 and ca.name = $2 group by ca.id`,
                    [game, name]
                )
            ).rows.map((r) => r.platforms);
        for (const name of ["Mega Strike", "All Together", "Learning!"]) expect(await platformsByName(name)).toEqual([["steam", "xbox"]]);
        // Two Steam "Sphere Hunter"s and two tagged Xbox ones: left for review.
        expect(await platformsByName("Sphere Hunter")).toEqual([["steam"], ["steam"]]);
    });

    it("never proposes a target that already has an achievement from the same list (#362)", async () => {
        const game = await canonicalStore.getOrCreateCanonicalGame("steam", "sith-app", "Sith Game");
        await canonicalStore.getOrCreateAchievementLink(game, "steam", "sith-app", "s1", "Sith Frenzy", undefined, undefined);
        const warrior = await canonicalStore.getOrCreateAchievementLink(game, "psn", "sith-list", "p1", "Sith Warrior", undefined, undefined);
        await canonicalStore.getOrCreateAchievementLink(game, "psn", "sith-list", "p2", "Sith Frenzy", undefined, undefined);

        await matcher.matchAchievementsForGame(game);
        await matcher.matchAchievementsForGame(game);
        const rows = await pool.query("select status from achievement_match_candidates where achievement_platform_link_id = $1", [warrior]);
        expect(rows.rows).toEqual([]);

        // A queued one from before the fix can't be confirmed either.
        const frenzy = await pool.query(
            "select canonical_achievement_id from achievement_platform_links where platform_id = 'psn' and platform_achievement_id = 'p2'"
        );
        const stale = await pool.query(
            `insert into achievement_match_candidates (achievement_platform_link_id, candidate_canonical_achievement_id, confidence)
             values ($1, $2, 0.5) returning id`,
            [warrior, frenzy.rows[0].canonical_achievement_id]
        );
        await expect(matcher.confirmMatchCandidate(stale.rows[0].id)).rejects.toThrow(/same list/);
    });

    it("keeps an ordinary exact name match auto-merging", async () => {
        const game = await canonicalStore.getOrCreateCanonicalGame("steam", "plain-app", "Plain Game");
        await canonicalStore.getOrCreateAchievementLink(game, "steam", "plain-app", "s1", "First Blood", undefined, undefined);
        const xboxLink = await canonicalStore.getOrCreateAchievementLink(game, "xbox", "plain-title", "x1", "First Blood", undefined, undefined);
        await matcher.matchAchievementsForGame(game);
        const status = await pool.query("select status from achievement_match_candidates where achievement_platform_link_id = $1", [xboxLink]);
        expect(status.rows).toEqual([{ status: "confirmed" }]);
    });
});
