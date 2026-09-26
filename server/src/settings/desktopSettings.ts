import { pool } from "../db";

// Desktop-app-only preferences (see #249), stored in app_settings like the
// Discord Rich Presence toggle and read by the Electron main process through
// GET /api/setup/desktop-settings.
export interface DesktopSettings {
    keepInTray: boolean;
    startWithWindows: boolean;
    unlockNotifications: boolean;
}

const KEYS: Record<keyof DesktopSettings, string> = {
    keepInTray: "desktop_keep_in_tray",
    startWithWindows: "desktop_start_with_windows",
    unlockNotifications: "desktop_unlock_notifications",
};

// Tray and startup are off by default: closing the window quits, and nothing
// is added to Windows startup, until the user opts in. Unlock notifications
// (see #250) are on, and only fire while the window isn't in front.
const DEFAULTS: DesktopSettings = { keepInTray: false, startWithWindows: false, unlockNotifications: true };

export async function getDesktopSettings(): Promise<DesktopSettings> {
    const result = await pool.query("select key, value from app_settings where key = any($1)", [Object.values(KEYS)]);
    const stored = new Map<string, string>(result.rows.map((row) => [row.key, row.value]));
    const settings = { ...DEFAULTS };
    for (const [name, key] of Object.entries(KEYS) as [keyof DesktopSettings, string][]) {
        if (stored.has(key)) settings[name] = stored.get(key) === "true";
    }
    return settings;
}

export async function updateDesktopSettings(changes: Partial<DesktopSettings>): Promise<DesktopSettings> {
    for (const [name, key] of Object.entries(KEYS) as [keyof DesktopSettings, string][]) {
        if (typeof changes[name] !== "boolean") continue;
        await pool.query(
            `insert into app_settings (key, value) values ($1, $2)
             on conflict (key) do update set value = excluded.value, updated_at = now()`,
            [key, String(changes[name])]
        );
    }
    return getDesktopSettings();
}

// Set by the Electron main process before it starts the server in-process, so
// the dashboard only offers these settings inside the desktop app.
export function isDesktopApp(): boolean {
    return process.env.UAM_DESKTOP === "1";
}
