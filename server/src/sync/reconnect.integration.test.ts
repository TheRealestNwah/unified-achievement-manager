import { beforeAll, afterAll, describe, expect, it } from "vitest";

const integrationEnabled = process.env.INTEGRATION_TESTS === "true";
const integration = integrationEnabled ? describe : describe.skip;

integration("assertSameAccountOnReconnect (#283)", () => {
    let pool: import("pg").Pool;
    let reconnect: typeof import("./reconnect");
    let userId: string;

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for integration tests");
        ({ pool } = await import("../db"));
        reconnect = await import("./reconnect");
        await pool.query("truncate table users cascade");
        userId = (await pool.query("insert into users (username) values ('reconnect-user') returning id")).rows[0].id;
        await pool.query(
            `insert into user_platform_accounts (user_id, platform_id, platform_account_id, display_name, last_sync_error, last_sync_error_at)
             values ($1, 'psn', 'psn-account-1', 'p1', 'expired', now())`,
            [userId]
        );
    });

    afterAll(async () => {
        await pool?.end();
    });

    it("allows a first connect and a reconnect of the same account", async () => {
        await expect(reconnect.assertSameAccountOnReconnect(userId, "xbox", "xuid-1", "Xbox")).resolves.toBeUndefined();
        await expect(reconnect.assertSameAccountOnReconnect(userId, "psn", "psn-account-1", "PSN")).resolves.toBeUndefined();
    });

    it("refuses to swap in a different account under the old one's data", async () => {
        await expect(reconnect.assertSameAccountOnReconnect(userId, "psn", "psn-account-2", "PSN")).rejects.toThrow(
            /different PSN account than the one already connected \(p1\)/
        );
    });

    it("clears the last sync error", async () => {
        await reconnect.clearSyncError(userId, "psn");
        const row = (await pool.query("select last_sync_error, last_sync_error_at from user_platform_accounts where user_id = $1", [userId])).rows[0];
        expect(row).toEqual({ last_sync_error: null, last_sync_error_at: null });
    });
});
