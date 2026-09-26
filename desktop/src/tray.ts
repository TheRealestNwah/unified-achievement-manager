import { app, BrowserWindow, Menu, Tray } from "electron";

// "Keep running in the system tray" and "Start with Windows" (see #249).
// Both are saved server-side (Settings → Desktop app) and read here through
// the local /api/setup/desktop-settings endpoint, polled so a toggle takes
// effect within a few seconds without an IPC channel to the dashboard.

interface DesktopSettings {
    keepInTray: boolean;
    startWithWindows: boolean;
    // Read by notifications.ts (see #250); polled here with the rest.
    unlockNotifications: boolean;
}

// Windows starts the app with this when "Start with Windows" is on, so it
// comes up in the tray instead of opening a window at login.
export const HIDDEN_LAUNCH_ARG = "--hidden";

const POLL_INTERVAL_MS = 5_000;

let settings: DesktopSettings = { keepInTray: false, startWithWindows: false, unlockNotifications: true };

export function unlockNotificationsEnabled(): boolean {
    return settings.unlockNotifications !== false;
}
let tray: Tray | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let quitting = false;
let hintShown = false;

export function launchedHidden(): boolean {
    return process.argv.includes(HIDDEN_LAUNCH_ARG);
}

// Set once a real quit starts, so the window's close handler lets it close.
export function markQuitting(): void {
    quitting = true;
}

export function showWindow(window: BrowserWindow | null): void {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
}

async function fetchSettings(serverUrl: string): Promise<DesktopSettings | null> {
    try {
        const res = await fetch(`${serverUrl}/api/setup/desktop-settings`);
        return res.ok ? ((await res.json()) as DesktopSettings) : null;
    } catch {
        return null;
    }
}

// Only a packaged app registers itself - a dev run would register the bare
// electron.exe.
function applyLoginItem(enabled: boolean): void {
    if (!app.isPackaged) return;
    const current = app.getLoginItemSettings({ args: [HIDDEN_LAUNCH_ARG] }).openAtLogin;
    if (current !== enabled) app.setLoginItemSettings({ openAtLogin: enabled, args: [HIDDEN_LAUNCH_ARG] });
}

async function ensureTray(getWindow: () => BrowserWindow | null): Promise<void> {
    if (tray) return;
    const icon = await app.getFileIcon(process.execPath, { size: "small" });
    tray = new Tray(icon);
    tray.setToolTip("Unified Achievement Manager");
    tray.setContextMenu(
        Menu.buildFromTemplate([
            { label: "Open Unified Achievement Manager", click: () => showWindow(getWindow()) },
            {
                label: "Sync all now",
                // Runs through the dashboard so the sync carries its session
                // and CSRF token, exactly like pressing Sync all.
                click: () => void getWindow()?.webContents.executeJavaScript("window.uamSyncAll?.()").catch(() => undefined),
            },
            { type: "separator" },
            { label: "Quit", click: () => app.quit() },
        ])
    );
    tray.on("click", () => showWindow(getWindow()));
}

function destroyTray(): void {
    tray?.destroy();
    tray = null;
}

async function refresh(serverUrl: string, getWindow: () => BrowserWindow | null): Promise<void> {
    const next = await fetchSettings(serverUrl);
    if (!next) return;
    settings = next;
    applyLoginItem(settings.startWithWindows);
    if (settings.keepInTray) await ensureTray(getWindow);
    else {
        destroyTray();
        // Launched hidden at login but the tray has since been turned off:
        // there'd be no way back to the window, so show it.
        const window = getWindow();
        if (window && !window.isVisible()) showWindow(window);
    }
}

export async function startTray(serverUrl: string, getWindow: () => BrowserWindow | null): Promise<void> {
    await refresh(serverUrl, getWindow);
    // A hidden launch only stays hidden if the tray actually came up.
    const window = getWindow();
    if (!tray && window && !window.isVisible()) showWindow(window);
    pollTimer = setInterval(() => void refresh(serverUrl, getWindow), POLL_INTERVAL_MS);
}

export function stopTray(): void {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    destroyTray();
}

// Closing the window hides it to the tray instead of quitting, while that
// setting is on and a real quit isn't under way.
export function handleWindowClose(event: Electron.Event, window: BrowserWindow): void {
    if (quitting || !settings.keepInTray || !tray) return;
    event.preventDefault();
    window.hide();
    if (!hintShown) {
        hintShown = true;
        tray.displayBalloon({
            title: "Still running",
            content: "Unified Achievement Manager keeps syncing in the background. Right-click the tray icon to quit.",
        });
    }
}
