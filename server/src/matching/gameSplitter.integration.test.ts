import { beforeAll, afterAll, describe, expect, it } from "vitest";

const integrationEnabled = process.env.INTEGRATION_TESTS === "true";
const integration = integrationEnabled ? describe : describe.skip;

integration("splitPlatformLink", () => {
    let pool: import("pg").Pool;
    let canonicalStore: typeof import("../sync/canonicalStore");
    let gameMatcher: typeof import("./gameMatcher");
    let achievementMatcher: typeof import("./achievementMatcher");
    let splitter: typeof import("./gameSplitter");
    let steamAccountId: string;
    let xboxAccountId: string;
    let steamGameId: string;
    let xboxGameId: string;
    let xboxLinkId: string;
    let xboxUnlockedLinkId: string;

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for integration tests");
        ({ pool } = await import("../db"));
        canonicalStore = await import("../sync/canonicalStore");
        gameMatcher = await import("./gameMatcher");
        achievementMatcher = await import("./achievementMatcher");
        splitter = await import("./gameSplitter");

        await pool.query("truncate table users, games, canonical_achievements cascade");

        const user = await pool.query("insert into users (username) values ($1) returning id", ["split-user"]);
        const accounts = await pool.query(
            `insert into user_platform_accounts (user_id, platform_id, platform_account_id, display_name)
             values ($1, 'steam', 'split-steam', 'Split'), ($1, 'xbox', 'split-xbox', 'Split')
             returning id, platform_id`,
            [user.rows[0].id]
        );
        steamAccountId = accounts.rows.find((r) => r.platform_id === "steam").id;
        xboxAccountId = accounts.rows.find((r) => r.platform_id === "xbox").id;

        // Same exact title on both platforms, so automatic matching merges
        // them - the case that most needs the split to stick.
        steamGameId = await canonicalStore.getOrCreateCanonicalGame("steam", "split-steam-app", "Split Game");
        xboxGameId = await canonicalStore.getOrCreateCanonicalGame("xbox", "split-xbox-title", "Split Game");
        await canonicalStore.recordOwnership(steamAccountId, steamGameId);
        await canonicalStore.recordOwnership(xboxAccountId, xboxGameId);

        await canonicalStore.getOrCreateAchievementLink(steamGameId, "steam", "split-steam-app", "S1", "Shared", "same on both", 50);
        await canonicalStore.getOrCreateAchievementLink(steamGameId, "steam", "split-steam-app", "S2", "Steam only", "only here", 50);
        xboxUnlockedLinkId = await canonicalStore.getOrCreateAchievementLink(
            xboxGameId,
            "xbox",
            "split-xbox-title",
            "X1",
            "Shared",
            "same on both",
            50
        );
        await canonicalStore.getOrCreateAchievementLink(xboxGameId, "xbox", "split-xbox-title", "X2", "Xbox only", "only here", 50);
        await canonicalStore.recordUnlock(xboxAccountId, xboxUnlockedLinkId, new Date("2026-01-01T00:00:00Z"));

        await gameMatcher.matchGames();
        const links = await pool.query("select id, game_id from game_platform_links where platform_id = 'xbox'");
        xboxLinkId = links.rows[0].id;
        steamGameId = links.rows[0].game_id;
        await achievementMatcher.matchAchievementsForGame(steamGameId);
    });

    afterAll(async () => {
        await pool?.end();
    });

    it("starts from a merged game with a fused achievement", async () => {
        const games = await pool.query("select id from games");
        expect(games.rows).toHaveLength(1);
        const shared = await pool.query(
            `select count(distinct platform_id)::int as n from achievement_platform_links apl
             join canonical_achievements ca on ca.id = apl.canonical_achievement_id where ca.name = 'Shared'`
        );
        expect(shared.rows[0].n).toBe(2);
        // "Xbox only" vs "Steam only" is left waiting for review (see #360).
        const pending = await pool.query("select 1 from achievement_match_candidates where status = 'pending'");
        expect(pending.rows).toHaveLength(1);
    });

    it("moves the platform entry, its achievements and its owners onto a new game", async () => {
        const result = await splitter.splitPlatformLink(steamGameId, xboxLinkId);
        expect(result).toMatchObject({ achievementsMoved: 1, achievementsCopied: 1 });

        const link = await pool.query("select game_id from game_platform_links where id = $1", [xboxLinkId]);
        expect(link.rows[0].game_id).toBe(result.newGameId);
        const title = await pool.query("select title from games where id = $1", [result.newGameId]);
        expect(title.rows[0].title).toBe("Split Game");

        const byGame = await pool.query(
            `select ca.game_id, apl.platform_id, ca.name from achievement_platform_links apl
             join canonical_achievements ca on ca.id = apl.canonical_achievement_id order by apl.platform_id, ca.name`
        );
        expect(byGame.rows).toEqual([
            { game_id: steamGameId, platform_id: "steam", name: "Shared" },
            { game_id: steamGameId, platform_id: "steam", name: "Steam only" },
            { game_id: result.newGameId, platform_id: "xbox", name: "Shared" },
            { game_id: result.newGameId, platform_id: "xbox", name: "Xbox only" },
        ]);

        const unlock = await pool.query("select 1 from user_achievement_unlocks where achievement_platform_link_id = $1", [
            xboxUnlockedLinkId,
        ]);
        expect(unlock.rows).toHaveLength(1);

        const owners = await pool.query("select user_platform_account_id, game_id from user_owned_games order by game_id");
        expect(owners.rows).toEqual(
            expect.arrayContaining([
                { user_platform_account_id: steamAccountId, game_id: steamGameId },
                { user_platform_account_id: xboxAccountId, game_id: result.newGameId },
            ])
        );
        expect(owners.rows).toHaveLength(2);

        // Its two sides are now in different games, so it's gone (#360).
        const pending = await pool.query("select 1 from achievement_match_candidates where status = 'pending'");
        expect(pending.rows).toHaveLength(0);
    });

    it("doesn't get merged back by the next matching run", async () => {
        await gameMatcher.matchGames();
        const games = await pool.query("select id from games");
        expect(games.rows).toHaveLength(2);
    });

    // Two lists on one platform under one game, like the MGS2 and MGS3 PS3
    // trophy lists under "METAL GEAR SOLID HD: 2 & 3" (see #207).
    it("splits one of two lists on the same platform, keeping ownership for accounts with unlocks", async () => {
        const secondGameId = await canonicalStore.getOrCreateCanonicalGame("steam", "split-steam-second", "Split Game Two");
        await canonicalStore.recordOwnership(steamAccountId, secondGameId);
        const unlockedLinkId = await canonicalStore.getOrCreateAchievementLink(
            secondGameId,
            "steam",
            "split-steam-second",
            "T1",
            "Second list",
            "only on the second list",
            50
        );
        await canonicalStore.recordUnlock(steamAccountId, unlockedLinkId, new Date("2026-01-02T00:00:00Z"));
        await gameMatcher.mergeGames(steamGameId, secondGameId);
        const secondLink = await pool.query("select id from game_platform_links where platform_game_id = 'split-steam-second'");

        const result = await splitter.splitPlatformLink(steamGameId, secondLink.rows[0].id);

        const owners = await pool.query("select game_id from user_owned_games where user_platform_account_id = $1", [steamAccountId]);
        expect(owners.rows.map((r) => r.game_id).sort()).toEqual([steamGameId, result.newGameId].sort());
        const moved = await pool.query(
            `select ca.game_id from achievement_platform_links apl
             join canonical_achievements ca on ca.id = apl.canonical_achievement_id where apl.id = $1`,
            [unlockedLinkId]
        );
        expect(moved.rows[0].game_id).toBe(result.newGameId);
    });

    it("refuses to split a game's only platform entry", async () => {
        await expect(splitter.splitPlatformLink(steamGameId, xboxLinkId)).rejects.toBeInstanceOf(splitter.GameSplitError);
        const steamLink = await pool.query("select id from game_platform_links where platform_id = 'steam'");
        await expect(splitter.splitPlatformLink(steamGameId, steamLink.rows[0].id)).rejects.toThrow(/only has one platform entry/);
    });
});
