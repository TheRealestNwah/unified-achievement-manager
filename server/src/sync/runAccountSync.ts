import { pool } from "../db";
import { SyncSummary } from "./types";
import { platformAdapters } from "./adapters";
import { runSyncPipeline } from "./pipeline";

export interface PlatformAccountRow {
    id: string;
    user_id: string;
    platform_id: string;
    platform_account_id: string;
    access_token: string | null;
    refresh_token: string | null;
}

// Syncs one linked account through the sync pipeline, using the platform's
// adapter (sync/adapters.ts). Shared by each platform's own /sync route and
// the background scheduler (scheduler.ts).
//
// One sync per account at a time (see #323): pressing Sync while the
// scheduler is already working through that account joins the running sync
// and gets its result, instead of starting a second full pass against the
// platform's API. In-memory is enough - the app is a single process.
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
    const adapter = platformAdapters[account.platform_id];
    if (!adapter) throw new Error(`No platform adapter for platform: ${account.platform_id}`);
    return runSyncPipeline(adapter, account.id);
}
