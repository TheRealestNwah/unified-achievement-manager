import { app, BrowserWindow, dialog } from "electron";
import { autoUpdater } from "electron-updater";

// Auto-update from this repo's GitHub Releases (see #314). electron-builder
// embeds app-update.yml pointing at them, and each release carries the
// latest.yml + .blockmap written next to the installer. Updates download in
// the background; the user is asked before a restart, and "Later" installs on
// the next quit. The installer is unsigned for now, so there's no publisher
// check - app-update.yml has no publisherName to compare against.

const FIRST_CHECK_DELAY_MS = 30_000;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

interface UpdaterOptions {
    getWindow: () => BrowserWindow | null;
    // Settings → Desktop app → Automatic updates; only gates background checks.
    automaticUpdatesEnabled: () => boolean;
    // Stops the server and bundled PostgreSQL before the installer runs, so
    // it isn't left to the installer's kill-on-init.
    beforeInstall: () => Promise<void>;
}

let options: UpdaterOptions | null = null;
let firstCheck: ReturnType<typeof setTimeout> | null = null;
let interval: ReturnType<typeof setInterval> | null = null;
let downloadedVersion: string | null = null;
let manualCheck = false;
let prompting = false;

function showMessage(box: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
    const window = options?.getWindow();
    return window && window.isVisible() ? dialog.showMessageBox(window, box) : dialog.showMessageBox(box);
}

async function promptRestart(): Promise<void> {
    if (prompting || !downloadedVersion || !options) return;
    prompting = true;
    try {
        const { response } = await showMessage({
            title: "Update ready",
            message: `Unified Achievement Manager ${downloadedVersion} is ready to install.`,
            detail: "Restart now to finish updating, or it'll install the next time you quit.",
            buttons: ["Restart now", "Later"],
            defaultId: 0,
            cancelId: 1,
        });
        if (response !== 0) return;
        await options.beforeInstall();
        // Silent, then relaunch - the assisted installer's wizard isn't needed
        // for an update into the same folder.
        autoUpdater.quitAndInstall(true, true);
    } finally {
        prompting = false;
    }
}

// "Nothing published yet" isn't a failure: until the first release after
// 1.0.0 exists, every check ends this way (see #324).
function isNoRelease(err: Error): boolean {
    const code = (err as Error & { code?: string }).code;
    return code === "ERR_UPDATER_NO_PUBLISHED_VERSIONS" || (code === "ERR_XML_MISSED_ELEMENT" && err.message.includes("No published versions"));
}

// A release without latest.yml attached - a release-checklist miss, not
// something the user can act on.
function isMissingChannelFile(err: Error): boolean {
    return (err as Error & { code?: string }).code === "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND";
}

function backgroundCheck(): void {
    if (downloadedVersion || !options?.automaticUpdatesEnabled()) return;
    // Failures are logged once, by the "error" handler.
    autoUpdater.checkForUpdates().catch(() => undefined);
}

export function startAutoUpdates(opts: UpdaterOptions): void {
    // Dev runs have no app-update.yml, and the smoke test quits in seconds.
    if (!app.isPackaged || process.env.UAM_SMOKE_TEST === "1") return;
    options = opts;
    // electron-updater's own error logging would repeat what the "error"
    // handler below logs, so only its info/warn lines go to the log.
    autoUpdater.logger = { info: console.info, warn: console.warn, error: () => undefined, debug: () => undefined };
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on("update-available", (info) => {
        console.log(`Update ${info.version} available, downloading`);
        if (!manualCheck) return;
        manualCheck = false;
        void showMessage({
            title: "Update available",
            message: `Unified Achievement Manager ${info.version} is downloading.`,
            detail: "You'll be asked to restart once it's ready.",
        });
    });
    autoUpdater.on("update-not-available", () => {
        if (!manualCheck) return;
        manualCheck = false;
        void showMessage({ title: "No updates", message: `You're on the latest version (${app.getVersion()}).` });
    });
    autoUpdater.on("error", (err) => {
        if (isNoRelease(err) || isMissingChannelFile(err)) {
            if (isNoRelease(err)) console.info("Update check: no release published yet");
            else console.warn(`Update check: the latest release has no latest.yml (${err.message.split(":")[0]})`);
            if (!manualCheck) return;
            manualCheck = false;
            void showMessage({ title: "No updates", message: `You're on the latest version (${app.getVersion()}).` });
            return;
        }
        console.error("Auto-update failed:", err);
        if (!manualCheck) return;
        manualCheck = false;
        void showMessage({
            type: "error",
            title: "Couldn't check for updates",
            message: "Couldn't check for updates. Check your internet connection and try again.",
            detail: err instanceof Error ? err.message : String(err),
        });
    });
    autoUpdater.on("update-downloaded", (info) => {
        console.log(`Update ${info.version} downloaded`);
        downloadedVersion = info.version;
        // Launched hidden in the tray: don't pop a dialog out of nowhere; it
        // installs on quit, or the next manual check offers the restart.
        if (opts.getWindow()?.isVisible()) void promptRestart();
    });

    firstCheck = setTimeout(backgroundCheck, FIRST_CHECK_DELAY_MS);
    interval = setInterval(backgroundCheck, CHECK_INTERVAL_MS);
}

export function stopAutoUpdates(): void {
    if (firstCheck) clearTimeout(firstCheck);
    if (interval) clearInterval(interval);
    firstCheck = interval = null;
}

// Help → Check for Updates. Works even with automatic updates turned off.
export async function checkForUpdatesNow(): Promise<void> {
    if (!options) {
        await dialog.showMessageBox({ title: "Check for Updates", message: "Updates are only available in the installed app." });
        return;
    }
    if (downloadedVersion) return promptRestart();
    manualCheck = true;
    try {
        await autoUpdater.checkForUpdates();
    } catch {
        // Reported by the "error" handler.
    }
}
