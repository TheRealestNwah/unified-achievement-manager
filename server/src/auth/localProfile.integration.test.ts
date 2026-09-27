import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";

const integrationEnabled = process.env.INTEGRATION_TESTS === "true";
const integration = integrationEnabled ? describe : describe.skip;

integration("local profile and Steam linking (#393)", () => {
    let pool: import("pg").Pool;
    let profile: typeof import("./localProfile");
    let linkSteamAccount: typeof import("./steamLink").linkSteamAccount;
    let SteamLinkError: typeof import("./steamLink").SteamLinkError;

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for integration tests");
        ({ pool } = await import("../db"));
        profile = await import("./localProfile");
        ({ linkSteamAccount, SteamLinkError } = await import("./steamLink"));
    });

    beforeEach(async () => {
        await pool.query("truncate table users cascade");
        await pool.query("delete from session");
        await pool.query("delete from app_settings where key = 'local_profile_user_id'");
    });

    afterAll(async () => {
        await pool?.end();
    });

    async function addUser(name: string): Promise<string> {
        return (await pool.query("insert into users (username) values ($1) returning id", [name])).rows[0].id;
    }

    it("has no profile on a fresh database, then exactly the one created", async () => {
        expect(await profile.getLocalProfile()).toBeNull();
        const created = await profile.createLocalProfile("Player One");
        expect((await profile.getLocalProfile())?.id).toBe(created.id);
        await expect(profile.createLocalProfile("Player Two")).rejects.toBeInstanceOf(profile.ProfileExistsError);
    });

    it("adopts the user an older database already has", async () => {
        const id = await addUser("Steam Name");
        expect((await profile.getLocalProfile())?.id).toBe(id);
        await expect(profile.createLocalProfile("Someone Else")).rejects.toBeInstanceOf(profile.ProfileExistsError);
    });

    it("picks the most recently signed-in user when an older database has several", async () => {
        const older = await addUser("Old Steam Account");
        const recent = await addUser("Main Steam Account");
        const session = (userId: string, expire: string) =>
            pool.query("insert into session (sid, sess, expire) values ($1, $2, $3)", [
                `sid-${userId}`,
                JSON.stringify({ cookie: {}, passport: { user: userId } }),
                expire,
            ]);
        await session(older, "2026-01-01T00:00:00Z");
        await session(recent, "2026-09-01T00:00:00Z");
        expect((await profile.getLocalProfile())?.id).toBe(recent);
    });

    it("moves on when the saved profile was deleted", async () => {
        const created = await profile.createLocalProfile("Gone Soon");
        await pool.query("delete from users where id = $1", [created.id]);
        expect(await profile.getLocalProfile()).toBeNull();
    });

    it("links Steam to the profile, is a no-op for the same account, and refuses a second one", async () => {
        const me = await profile.createLocalProfile("Player");
        await linkSteamAccount(me.id, { steamId: "7656119000000001", displayName: "Steam Me" });
        await linkSteamAccount(me.id, { steamId: "7656119000000001", displayName: "Steam Me" });
        const rows = await pool.query("select platform_account_id from user_platform_accounts where user_id = $1 and platform_id = 'steam'", [me.id]);
        expect(rows.rows).toEqual([{ platform_account_id: "7656119000000001" }]);
        await expect(linkSteamAccount(me.id, { steamId: "7656119000000002", displayName: "Other" })).rejects.toBeInstanceOf(SteamLinkError);
    });

    it("moves a Steam account over from another user row an older database left behind", async () => {
        const leftover = await addUser("Leftover");
        await pool.query(
            "insert into user_platform_accounts (user_id, platform_id, platform_account_id, display_name) values ($1, 'steam', '7656119000000003', 'Old')",
            [leftover]
        );
        await pool.query("insert into app_settings (key, value) values ('local_profile_user_id', $1)", [await addUser("Me")]);
        const me = (await profile.getLocalProfile())!;
        await linkSteamAccount(me.id, { steamId: "7656119000000003", displayName: "Steam Me" });
        const row = await pool.query("select user_id from user_platform_accounts where platform_account_id = '7656119000000003'");
        expect(row.rows[0].user_id).toBe(me.id);
    });
});
