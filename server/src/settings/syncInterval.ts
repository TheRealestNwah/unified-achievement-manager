import { pool } from "../db";

const SETTING_KEY = "sync_interval_minutes";

// The choices offered in Settings -> Background sync (see #289). null = off.
export const SYNC_INTERVAL_CHOICES: (number | null)[] = [null, 60, 180, 360, 720, 1440];

export function isValidSyncInterval(value: unknown): value is number | null {
    return value === null || (typeof value === "number" && SYNC_INTERVAL_CHOICES.includes(value));
}

// The saved interval, or `fallback` (SCHEDULER_INTERVAL_MINUTES) when the
// user hasn't picked one.
export async function getSyncIntervalMinutes(fallback: number): Promise<number | null> {
    const result = await pool.query("select value from app_settings where key = $1", [SETTING_KEY]);
    const value = result.rows[0]?.value;
    if (value === undefined) return fallback;
    if (value === "off") return null;
    const minutes = Number(value);
    return Number.isFinite(minutes) && minutes > 0 ? minutes : fallback;
}

export async function setSyncIntervalMinutes(minutes: number | null): Promise<void> {
    await pool.query(
        `insert into app_settings (key, value) values ($1, $2)
         on conflict (key) do update set value = excluded.value, updated_at = now()`,
        [SETTING_KEY, minutes === null ? "off" : String(minutes)]
    );
}
