import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";

const integrationEnabled = process.env.INTEGRATION_TESTS === "true";
const integration = integrationEnabled ? describe : describe.skip;

// The Steam sync itself is stubbed - this is about what runAccountSync
// records around it, not about talking to Steam.
const syncSteamAccount = vi.fn();
vi.mock("../steam/sync", () => ({ syncSteamAccount: (...args: unknown[]) => syncSteamAccount(...args) }));

integration("runAccountSync sync-error tracking (#282)", () => {
    let pool: import("pg").Pool;
    let runAccountSync: typeof import("./runAccountSync").runAccountSync;
    let account: import("./runAccountSync").PlatformAccountRow;

    async function errorColumns() {
        return (await pool.query("select last_sync_error, last_sync_error_at from user_platform_accounts where id = $1", [account.id])).rows[0];
    }

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for integration tests");
        ({ pool } = await import("../db"));
        ({ runAccountSync } = await import("./runAccountSync"));
        await pool.query("truncate table users cascade");
        const userId = (await pool.query("insert into users (username) values ('sync-error-user') returning id")).rows[0].id;
        const row = await pool.query(
            `insert into user_platform_accounts (user_id, platform_id, platform_account_id, display_name)
             values ($1, 'steam', 'sync-error-steam', 'Sync Error') returning id, user_id, platform_id, platform_account_id, access_token, refresh_token`,
            [userId]
        );
        account = row.rows[0];
    });

    afterAll(async () => {
        await pool?.end();
    });

    it("records a failure's message and clears it after the next success", async () => {
        syncSteamAccount.mockRejectedValueOnce(new Error("Steam said no"));
        await expect(runAccountSync(account)).rejects.toThrow("Steam said no");
        const failed = await errorColumns();
        expect(failed.last_sync_error).toBe("Steam said no");
        expect(failed.last_sync_error_at).toBeInstanceOf(Date);

        syncSteamAccount.mockResolvedValueOnce({ gamesProcessed: 0, achievementsUnlocked: 0 });
        await runAccountSync(account);
        expect(await errorColumns()).toEqual({ last_sync_error: null, last_sync_error_at: null });
    });
});
