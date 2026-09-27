import { pool } from "../db";
import { syncSteamAccount } from "../steam/sync";
import { syncXboxAccount } from "../xbox/sync";
import { syncPsnAccount } from "../psn/sync";
import { exchangeRefreshTokenForTokens } from "../psn/client";
import { syncRetroAccount } from "../retro/sync";
import { syncGogAccount } from "../gog/sync";
import { exchangeRefreshTokenForTokens as exchangeGogRefreshTokenForTokens } from "../gog/client";
import { SyncSummary } from "./types";
import { config } from "../config";
import { decryptCredential, encryptCredential } from "../security/credentials";

export interface PlatformAccountRow {
    id: string;
    user_id: string;
    platform_id: string;
    platform_account_id: string;
    access_token: string | null;
    refresh_token: string | null;
}

// Dispatches to the right platform's sync function for one linked account,
// including PSN's refresh-then-sync dance (its access tokens last roughly an
// hour, so every sync refreshes unconditionally rather than tracking expiry).
// Shared by each platform's own /sync route and the background scheduler
// (scheduler.ts) so this per-platform logic - including PSN's token refresh -
// only lives in one place.
//
// One sync per account at a time (see #323): pressing Sync while the
// scheduler is already working through that account joins the running sync
// and gets its result, instead of starting a second full pass against the
// platform's API. In-memory is enough - app mode and the classic server are
// each a single process.
const inFlight = new Map<string, Promise<SyncSummary>>();

// Accounts with a sync under way right now, for the dashboard (see #322).
export function syncingAccountIds(): Set<string> {
    return new Set(inFlight.keys());
}

export function runAccountSync(account: PlatformAccountRow): Promise<SyncSummary> {
    const running = inFlight.get(account.id);
    if (running) return running;
    const sync = syncAndRecord(account).finally(() => inFlight.delete(account.id));
    inFlight.set(account.id, sync);
    return sync;
}

async function syncAndRecord(account: PlatformAccountRow): Promise<SyncSummary> {
    try {
        const summary = await syncByPlatform(account);
        await pool.query("update user_platform_accounts set last_sync_error = null, last_sync_error_at = null where id = $1", [account.id]);
        return summary;
    } catch (err) {
        await recordSyncError(account.id, err);
        throw err;
    }
}

// Kept per account so both scheduled and manual failures reach the dashboard
// (see #282). Trimmed - some platform errors carry whole response bodies.
const MAX_SYNC_ERROR_LENGTH = 500;

export async function recordSyncError(accountId: string, err: unknown): Promise<void> {
    const message = (err instanceof Error ? err.message : String(err)).trim() || "Unknown error";
    try {
        await pool.query("update user_platform_accounts set last_sync_error = $2, last_sync_error_at = now() where id = $1", [
            accountId,
            message.slice(0, MAX_SYNC_ERROR_LENGTH),
        ]);
    } catch (recordErr) {
        // Never hide the original sync error behind a failure to record it.
        console.error("Couldn't record a sync error:", recordErr);
    }
}

async function syncByPlatform(account: PlatformAccountRow): Promise<SyncSummary> {
    const accessToken = account.access_token ? decryptCredential(account.access_token, config.credentialEncryptionKey) : null;
    const refreshToken = account.refresh_token ? decryptCredential(account.refresh_token, config.credentialEncryptionKey) : null;

    switch (account.platform_id) {
        case "steam":
            return syncSteamAccount(account.id, account.platform_account_id);

        case "xbox":
            return syncXboxAccount(account.id, accessToken!, account.platform_account_id);

        case "psn": {
            const tokens = await exchangeRefreshTokenForTokens(refreshToken!);
            await pool.query(
                "update user_platform_accounts set access_token = $1, refresh_token = $2 where id = $3",
                [encryptCredential(tokens.accessToken, config.credentialEncryptionKey), encryptCredential(tokens.refreshToken, config.credentialEncryptionKey), account.id]
            );
            return syncPsnAccount(account.id, tokens.accessToken);
        }

        case "retroachievements":
            return syncRetroAccount(account.id, account.platform_account_id, accessToken!);

        case "gog": {
            const tokens = await exchangeGogRefreshTokenForTokens(refreshToken!);
            await pool.query(
                "update user_platform_accounts set access_token = $1, refresh_token = $2 where id = $3",
                [encryptCredential(tokens.accessToken, config.credentialEncryptionKey), encryptCredential(tokens.refreshToken, config.credentialEncryptionKey), account.id]
            );
            return syncGogAccount(account.id, tokens.accessToken, account.platform_account_id);
        }

        default:
            throw new Error(`No sync handler for platform: ${account.platform_id}`);
    }
}
