import { pool } from "./db";
import { runAccountSync, PlatformAccountRow } from "./sync/runAccountSync";
import { recomputeUserScore } from "./scoring";
import { runMatching } from "./matching";
import { getSyncIntervalMinutes } from "./settings/syncInterval";

// Every account still syncs fine on demand from the dashboard; this just
// automates that instead of requiring a click. One account failing (an expired PSN NPSSO, a revoked
// Xbox key) logs and moves on rather than aborting the whole run, since a
// scheduled job with no one watching it shouldn't silently stop covering
// every other account over one bad one.
//
// The interval is the user's Settings -> Background sync choice when there is
// one (see #289), falling back to every 6 hours, and can be
// changed without a restart via applySchedulerInterval().
let started = false;
let defaultIntervalMinutes = 360;
let intervalMinutes: number | null = null;
let nextRunAt: Date | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;

export function startScheduler(fallbackIntervalMinutes: number): () => void {
    started = true;
    defaultIntervalMinutes = fallbackIntervalMinutes;
    void applySchedulerInterval({ runNow: true });
    return () => {
        started = false;
        clearTimer();
    };
}

// Re-reads the interval and reschedules. A change takes effect from now
// rather than triggering an immediate sync. Startup syncs straight away, but
// only accounts not synced (or tried) within the interval, so relaunching the
// app doesn't re-sync everything each time and burn rate limits (see #407).
export async function applySchedulerInterval({ runNow = false } = {}): Promise<void> {
    if (!started) return;
    let minutes: number | null;
    try {
        minutes = await getSyncIntervalMinutes(defaultIntervalMinutes);
    } catch (err) {
        console.error("Couldn't read the background sync interval; using the default:", err);
        minutes = defaultIntervalMinutes;
    }
    clearTimer();
    intervalMinutes = minutes;
    if (minutes === null) {
        console.log("Background sync is off - platforms only sync when asked.");
        return;
    }
    console.log(`Background sync scheduler enabled - running every ${minutes} minute(s).`);
    if (runNow) runScheduledSyncOnce(minutes);
    scheduleNext(minutes);
}

export function getSchedulerStatus(): { enabled: boolean; intervalMinutes: number | null; nextRunAt: Date | null } {
    return { enabled: started, intervalMinutes, nextRunAt };
}

function scheduleNext(minutes: number): void {
    const ms = minutes * 60 * 1000;
    nextRunAt = new Date(Date.now() + ms);
    timer = setTimeout(() => {
        runScheduledSyncOnce();
        scheduleNext(minutes);
    }, ms);
}

function clearTimer(): void {
    if (timer) clearTimeout(timer);
    timer = null;
    nextRunAt = null;
}

// A slow run (a big first sync) mustn't overlap the next one. With
// onlyStaleForMinutes, accounts synced or tried more recently than that are
// left for the next run.
function runScheduledSyncOnce(onlyStaleForMinutes: number | null = null): void {
    if (running) return;
    running = true;
    runScheduledSync(onlyStaleForMinutes)
        .catch((err) => console.error("Scheduled sync failed:", err))
        .finally(() => {
            running = false;
        });
}

async function runScheduledSync(onlyStaleForMinutes: number | null): Promise<void> {
    // greatest() ignores nulls, so a never-synced account is always due.
    const accounts = await pool.query(
        `select id, user_id, platform_id, platform_account_id, access_token, refresh_token from user_platform_accounts
         where $1::int is null
            or greatest(last_synced_at, last_sync_error_at) is null
            or greatest(last_synced_at, last_sync_error_at) < now() - make_interval(mins => $1::int)`,
        [onlyStaleForMinutes]
    );
    if (accounts.rows.length === 0) {
        if (onlyStaleForMinutes !== null) console.log("Scheduled sync: every linked account synced recently - nothing due yet.");
        return;
    }

    console.log(`Scheduled sync: syncing ${accounts.rows.length} linked account(s)...`);
    let succeeded = 0;

    for (const account of accounts.rows as PlatformAccountRow[]) {
        try {
            await runAccountSync(account);
            await recomputeUserScore(account.user_id);
            succeeded++;
        } catch (err) {
            console.error(`Scheduled sync failed for account ${account.id} (${account.platform_id}):`, err);
        }
    }

    // Cross-platform matches/tiers can shift with new data from any account,
    // and this already rescores every user as its last step.
    if (succeeded > 0) {
        await runMatching();
    }

    console.log(`Scheduled sync complete: ${succeeded}/${accounts.rows.length} account(s) synced.`);
}
