import { afterAll, beforeAll, describe, expect, it } from "vitest";

const integrationEnabled = process.env.INTEGRATION_TESTS === "true";
const integration = integrationEnabled ? describe : describe.skip;

// Steam's and Xbox's old skip tables become change markers on upgrade, in the
// format their adapters now produce, so the first sync doesn't re-fetch
// everything.
integration("schema migration of old sync state into change markers", () => {
    let pool: import("pg").Pool;
    let applySchema: typeof import("./migrate").applySchema;
    let steamAccount: string;
    let xboxAccount: string;

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for integration tests");
        ({ pool } = await import("../db"));
        ({ applySchema } = await import("./migrate"));
        await pool.query("truncate table users cascade");
        const userId = (await pool.query("insert into users (username) values ('marker-migration-user') returning id")).rows[0].id;
        const insertAccount = async (platform: string) =>
            (
                await pool.query(
                    `insert into user_platform_accounts (user_id, platform_id, platform_account_id, display_name)
                     values ($1, $2, $2 || '-migration', 'Migration') returning id`,
                    [userId, platform]
                )
            ).rows[0].id;
        steamAccount = await insertAccount("steam");
        xboxAccount = await insertAccount("xbox");

        // Recreate the tables as an older install left them.
        await pool.query(`
            create table steam_game_sync_state (
                user_platform_account_id uuid not null references user_platform_accounts(id) on delete cascade,
                appid integer not null, playtime_forever integer not null, rtime_last_played integer not null,
                primary key (user_platform_account_id, appid));
            create table xbox_title_sync_state (
                user_platform_account_id uuid not null references user_platform_accounts(id) on delete cascade,
                title_id text not null, progress text not null,
                primary key (user_platform_account_id, title_id));
        `);
        await pool.query("insert into steam_game_sync_state values ($1, 620, 90, 1700000000)", [steamAccount]);
        await pool.query("insert into xbox_title_sync_state values ($1, '100', '5|1|10|t1')", [xboxAccount]);
    });

    afterAll(async () => {
        await pool?.end();
    });

    it("copies both tables into change_markers and drops them", async () => {
        await applySchema();

        const markers = await pool.query("select user_platform_account_id, platform_game_id, marker from change_markers order by marker");
        expect(markers.rows).toEqual([
            { user_platform_account_id: xboxAccount, platform_game_id: "100", marker: "5|1|10|t1" },
            { user_platform_account_id: steamAccount, platform_game_id: "620", marker: "90:1700000000" },
        ]);
        const left = await pool.query("select to_regclass('steam_game_sync_state') as steam, to_regclass('xbox_title_sync_state') as xbox");
        expect(left.rows[0]).toEqual({ steam: null, xbox: null });

        // Running it again is a no-op.
        await applySchema();
        expect((await pool.query("select count(*)::int as n from change_markers")).rows[0].n).toBe(2);
    });
});
