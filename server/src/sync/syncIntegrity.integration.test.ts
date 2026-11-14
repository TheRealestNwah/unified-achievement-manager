import { beforeAll, afterAll, describe, expect, it } from "vitest";

const integrationEnabled = process.env.INTEGRATION_TESTS === "true";
const integration = integrationEnabled ? describe : describe.skip;

integration("sync data integrity", () => {
    let pool: import("pg").Pool;
    let canonicalStore: typeof import("./canonicalStore");
    let deleteUserAccount: typeof import("../auth/accountDeletion").deleteUserAccount;
    let accountId: string;
    let gameId: string;
    let secondGameId: string;
    let achievementLinkId: string;

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for integration tests");
        ({ pool } = await import("../db"));
        canonicalStore = await import("./canonicalStore");
        ({ deleteUserAccount } = await import("../auth/accountDeletion"));

        await pool.query("truncate table users, games, canonical_achievements cascade");

        const user = await pool.query("insert into users (username) values ($1) returning id", ["integration-user"]);
        const account = await pool.query(
            `insert into user_platform_accounts
                (user_id, platform_id, platform_account_id, display_name)
             values ($1, 'steam', $2, $3) returning id`,
            [user.rows[0].id, "integration-steam-id", "Integration User"]
        );
        accountId = account.rows[0].id;
    });

    afterAll(async () => {
        await pool?.end();
    });

    it("keeps repeated game and achievement ingestion idempotent", async () => {
        gameId = await canonicalStore.getOrCreateCanonicalGame("steam", "integration-app", "Integration Game");
        expect(await canonicalStore.getOrCreateCanonicalGame("steam", "integration-app", "Integration Game")).toBe(gameId);

        achievementLinkId = await canonicalStore.getOrCreateAchievementLink(
            gameId,
            { platformId: "steam", platformGameId: "integration-app", platformAchievementId: "integration-achievement" },
            { name: "Integration Achievement", description: "An integration-test achievement", rarity: 25 }
        );
        expect(
            await canonicalStore.getOrCreateAchievementLink(
                gameId,
                { platformId: "steam", platformGameId: "integration-app", platformAchievementId: "integration-achievement" },
                { name: "Integration Achievement", description: "An integration-test achievement", rarity: 25 }
            )
        ).toBe(achievementLinkId);

        await canonicalStore.recordOwnership(accountId, gameId);
        await canonicalStore.recordOwnership(accountId, gameId);
        expect(await canonicalStore.recordUnlock(accountId, achievementLinkId, new Date("2026-01-01T00:00:00Z"))).toBe(true);
        expect(await canonicalStore.recordUnlock(accountId, achievementLinkId, new Date("2026-01-02T00:00:00Z"))).toBe(false);

        const counts = await pool.query(`
            select
                (select count(*) from games where id = $1) as games,
                (select count(*) from game_platform_links where platform_id = 'steam' and platform_game_id = 'integration-app') as game_links,
                (select count(*) from canonical_achievements where game_id = $1) as canonical_achievements,
                (select count(*) from achievement_platform_links where platform_id = 'steam' and platform_game_id = 'integration-app') as achievement_links,
                (select count(*) from user_owned_games where user_platform_account_id = $2 and game_id = $1) as ownership,
                (select count(*) from user_achievement_unlocks where user_platform_account_id = $2 and achievement_platform_link_id = $3) as unlocks
        `, [gameId, accountId, achievementLinkId]);
        expect(counts.rows[0]).toMatchObject({
            games: "1",
            game_links: "1",
            canonical_achievements: "1",
            achievement_links: "1",
            ownership: "1",
            unlocks: "1",
        });
    });

    it("reconciles a missing game only after three consecutive reports", async () => {
        secondGameId = await canonicalStore.getOrCreateCanonicalGame("steam", "integration-app-2", "Integration Game 2");
        await canonicalStore.recordOwnership(accountId, secondGameId);

        expect(await canonicalStore.reconcileMissingOwnership(accountId, [secondGameId])).toEqual({
            gamesReconciled: 0,
            achievementsRevoked: 0,
        });
        expect(await canonicalStore.reconcileMissingOwnership(accountId, [secondGameId])).toEqual({
            gamesReconciled: 0,
            achievementsRevoked: 0,
        });
        expect(await canonicalStore.reconcileMissingOwnership(accountId, [secondGameId])).toEqual({
            gamesReconciled: 1,
            achievementsRevoked: 1,
        });

        const remaining = await pool.query(
            `select
                (select count(*) from user_owned_games where user_platform_account_id = $1 and game_id = $2) as missing_ownership,
                (select count(*) from user_owned_games where user_platform_account_id = $1 and game_id = $3) as current_ownership,
                (select count(*) from user_achievement_unlocks where user_platform_account_id = $1) as unlocks,
                (select count(*) from game_absence_streaks where user_platform_account_id = $1) as absence_streaks`,
            [accountId, gameId, secondGameId]
        );
        expect(remaining.rows[0]).toEqual({
            missing_ownership: "0",
            current_ownership: "1",
            unlocks: "0",
            absence_streaks: "0",
        });
    });

    it("deletes an account, revokes every session, and leaves shared data intact", async () => {
        const user = await pool.query("insert into users (username) values ($1) returning id", ["delete-me"]);
        const userId = user.rows[0].id;
        const account = await pool.query(
            `insert into user_platform_accounts (user_id, platform_id, platform_account_id, display_name)
             values ($1, 'steam', $2, $3) returning id`,
            [userId, "delete-me-steam-id", "Delete Me"]
        );
        const targetAccountId = account.rows[0].id;
        const achievement = await pool.query(
            "select canonical_achievement_id from achievement_platform_links where id = $1",
            [achievementLinkId]
        );
        await pool.query(
            "insert into session (sid, sess, expire) values ($1, $2, now() + interval '1 day')",
            ["delete-me-session", JSON.stringify({ passport: { user: userId } })]
        );
        await pool.query(
            "insert into user_game_cover_overrides (user_id, game_id, cover_image_url) values ($1, $2, $3)",
            [userId, gameId, "https://example.test/cover.png"]
        );
        await pool.query(
            "insert into user_achievement_icon_overrides (user_id, canonical_achievement_id, icon_url) values ($1, $2, $3)",
            [userId, achievement.rows[0].canonical_achievement_id, "https://example.test/icon.png"]
        );
        await canonicalStore.recordOwnership(targetAccountId, secondGameId);

        expect(await deleteUserAccount(userId)).toEqual({ fileCleanupPending: false });

        const counts = await pool.query(
            `select
                (select count(*) from users where id = $1) as users,
                (select count(*) from user_platform_accounts where user_id = $1) as accounts,
                (select count(*) from user_owned_games where user_platform_account_id = $2) as ownership,
                (select count(*) from user_game_cover_overrides where user_id = $1) as covers,
                (select count(*) from user_achievement_icon_overrides where user_id = $1) as icons,
                (select count(*) from session where sid = 'delete-me-session') as sessions,
                (select count(*) from games where id = $3) as shared_game
            `,
            [userId, targetAccountId, gameId]
        );
        expect(counts.rows[0]).toEqual({
            users: "0",
            accounts: "0",
            ownership: "0",
            covers: "0",
            icons: "0",
            sessions: "0",
            shared_game: "1",
        });
    });
});
