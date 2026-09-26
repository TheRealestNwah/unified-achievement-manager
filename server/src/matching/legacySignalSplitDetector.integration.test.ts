import { beforeAll, afterAll, describe, expect, it } from "vitest";

const integrationEnabled = process.env.INTEGRATION_TESTS === "true";
const integration = integrationEnabled ? describe : describe.skip;

// The RE1 case (#230): a RetroAchievements-linked classic title that got
// merged into a same-titled modern release before matchGames refused to
// auto-merge that shape. Detection has to find it even though the merge
// already happened and left no other trace (mergeGames deletes the loser
// row) - it works off the current shape of game_platform_links, not history.
integration("detectLegacySignalSplitCandidates", () => {
    let pool: import("pg").Pool;
    let canonicalStore: typeof import("../sync/canonicalStore");
    let gameMatcher: typeof import("./gameMatcher");
    let detector: typeof import("./legacySignalSplitDetector");
    let retroGameId: string;
    let steamGameId: string;
    let retroLinkId: string;

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for integration tests");
        ({ pool } = await import("../db"));
        canonicalStore = await import("../sync/canonicalStore");
        gameMatcher = await import("./gameMatcher");
        detector = await import("./legacySignalSplitDetector");

        await pool.query("truncate table users, games, canonical_achievements cascade");

        const user = await pool.query("insert into users (username) values ($1) returning id", ["legacy-split-user"]);
        const accounts = await pool.query(
            `insert into user_platform_accounts (user_id, platform_id, platform_account_id, display_name)
             values ($1, 'retroachievements', 'legacy-split-ra', 'Legacy'), ($1, 'steam', 'legacy-split-steam', 'Legacy')
             returning id, platform_id`,
            [user.rows[0].id]
        );
        const raAccountId = accounts.rows.find((r) => r.platform_id === "retroachievements").id;
        const steamAccountId = accounts.rows.find((r) => r.platform_id === "steam").id;

        // Simulate a pre-review-gate merge: create both platform links under
        // the SAME canonical game directly (skipping matchGames), same as
        // what an old auto-merge run would have left behind.
        retroGameId = await canonicalStore.getOrCreateCanonicalGame("retroachievements", "re1-ra", "Resident Evil");
        await canonicalStore.recordOwnership(raAccountId, retroGameId);
        const retroLink = await pool.query(
            "select id from game_platform_links where platform_id = 'retroachievements' and platform_game_id = 're1-ra'"
        );
        retroLinkId = retroLink.rows[0].id;

        await pool.query(
            `insert into game_platform_links (game_id, platform_id, platform_game_id, platform_title)
             values ($1, 'steam', 're1-steam', 'Resident Evil')`,
            [retroGameId]
        );
        await canonicalStore.recordOwnership(steamAccountId, retroGameId);
        steamGameId = retroGameId;
    });

    afterAll(async () => {
        await pool?.end();
    });

    it("flags the RetroAchievements link on an already-merged game", async () => {
        const result = await detector.detectLegacySignalSplitCandidates();
        expect(result.candidatesRecorded).toBe(1);

        const candidates = await pool.query(
            "select game_id, game_platform_link_id, reason, status from game_split_candidates"
        );
        expect(candidates.rows).toEqual([
            { game_id: retroGameId, game_platform_link_id: retroLinkId, reason: "exact-title-retro", status: "pending" },
        ]);
    });

    it("is idempotent across repeated detection runs", async () => {
        await detector.detectLegacySignalSplitCandidates();
        const candidates = await pool.query("select id from game_split_candidates");
        expect(candidates.rows).toHaveLength(1);
    });

    it("splits the RetroAchievements link into its own game on confirm", async () => {
        const candidate = await pool.query("select id from game_split_candidates where status = 'pending'");
        const result = await detector.confirmGameSplitCandidate(candidate.rows[0].id);

        const link = await pool.query("select game_id from game_platform_links where id = $1", [retroLinkId]);
        expect(link.rows[0].game_id).toBe(result.newGameId);
        expect(link.rows[0].game_id).not.toBe(steamGameId);

        const status = await pool.query("select status from game_split_candidates where id = $1", [candidate.rows[0].id]);
        expect(status.rows[0].status).toBe("confirmed");
    });

    it("doesn't get re-flagged or re-merged after the split", async () => {
        const result = await detector.detectLegacySignalSplitCandidates();
        expect(result.candidatesRecorded).toBe(0);

        await gameMatcher.matchGames();
        const games = await pool.query("select id from games");
        expect(games.rows).toHaveLength(2);
    });
});
