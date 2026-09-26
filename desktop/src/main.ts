import fs from "fs";
import path from "path";
import { format } from "util";
import { app, BrowserWindow, dialog, Menu, session, shell } from "electron";
import { startDiscordPresence, stopDiscordPresence } from "./discordPresence";
import { handleWindowClose, launchedHidden, markQuitting, showWindow, startTray, stopTray, unlockNotificationsEnabled } from "./tray";
import { startUnlockNotifications, stopUnlockNotifications } from "./notifications";
import { loadWindowState, trackWindowState } from "./windowState";

interface RunningApp {
    url: string;
    dataDir: string;
    stop(): Promise<void>;
}

const PROJECT_URL = "https://github.com/TheRealestNwah/unified-achievement-manager";

let mainWindow: BrowserWindow | null = null;
let running: RunningApp | null = null;
let shutdown: Promise<void> | null = null;
let appOrigin = "";

// Tests and the installer smoke check point the app at a scratch folder.
if (process.env.UAM_DATA_DIR) app.setPath("userData", path.resolve(process.env.UAM_DATA_DIR));
const dataDir = app.getPath("userData");
const logFile = path.join(dataDir, "logs", "main.log");

// A packaged app has no console, so everything the server logs goes to a file
// the user can find from the File menu.
function captureLogs(): void {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    try {
        if (fs.statSync(logFile).size > 5 * 1024 * 1024) fs.renameSync(logFile, `${logFile}.old`);
    } catch {
        // No log yet.
    }
    const stream = fs.createWriteStream(logFile, { flags: "a" });
    for (const level of ["log", "info", "warn", "error"] as const) {
        const original = console[level].bind(console);
        console[level] = (...args: unknown[]) => {
            stream.write(`${new Date().toISOString()} [${level}] ${format(...args)}\n`);
            original(...args);
        };
    }
}

function serverEntry(): string {
    return app.isPackaged
        ? path.join(process.resourcesPath, "server", "dist", "app.js")
        : path.join(__dirname, "..", "..", "server", "dist", "app.js");
}

function isAppUrl(url: string): boolean {
    try {
        return new URL(url).origin === appOrigin;
    } catch {
        return false;
    }
}

// Steam's OpenID sign-in has to happen inside the app window so the session
// cookie it ends with lands in the app, not in the user's browser.
function isSteamSignIn(url: string): boolean {
    try {
        const parsed = new URL(url);
        return parsed.protocol === "https:" && parsed.hostname === "steamcommunity.com" && parsed.pathname.startsWith("/openid");
    } catch {
        return false;
    }
}

function openExternally(url: string): void {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
}

function guardNavigation(event: Electron.Event, url: string): void {
    if (isAppUrl(url) || isSteamSignIn(url)) return;
    event.preventDefault();
    openExternally(url);
}

const LOADING_PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html><head><meta charset="utf-8"><title>Unified Achievement Manager</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; height: 100vh; display: grid; place-items: center; font-family: "Segoe UI", system-ui, sans-serif; background: Canvas; color: CanvasText; }
  p { opacity: .7; }
</style></head>
<body><div style="text-align:center"><h2>Unified Achievement Manager</h2><p>Starting up&hellip; the first launch takes a few seconds longer.</p></div></body></html>`)}`;

function createWindow(): BrowserWindow {
    const saved = loadWindowState(dataDir);
    const window = new BrowserWindow({
        ...saved.bounds,
        minWidth: 720,
        minHeight: 520,
        title: "Unified Achievement Manager",
        show: false,
        autoHideMenuBar: true,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });
    // A login-time launch starts in the tray; startTray() shows the window if
    // the tray setting turns out to be off. (maximize() would also show it.)
    window.once("ready-to-show", () => {
        if (launchedHidden()) return;
        if (saved.maximized) window.maximize();
        window.show();
    });
    trackWindowState(window, dataDir);
    window.on("close", (event) => handleWindowClose(event, window));
    window.webContents.setWindowOpenHandler(({ url }) => {
        openExternally(url);
        return { action: "deny" };
    });
    window.webContents.on("will-navigate", guardNavigation);
    window.webContents.on("will-redirect", guardNavigation);
    void window.loadURL(LOADING_PAGE);
    return window;
}

function buildMenu(): void {
    Menu.setApplicationMenu(
        Menu.buildFromTemplate([
            {
                label: "File",
                submenu: [
                    { label: "Open Data Folder", click: () => void shell.openPath(dataDir) },
                    { label: "Open Log File", click: () => void shell.openPath(logFile) },
                    { type: "separator" },
                    { role: "quit" },
                ],
            },
            { role: "editMenu" },
            {
                label: "View",
                submenu: [
                    { role: "reload" },
                    { role: "toggleDevTools" },
                    { type: "separator" },
                    { role: "resetZoom" },
                    { role: "zoomIn" },
                    { role: "zoomOut" },
                    { type: "separator" },
                    { role: "togglefullscreen" },
                ],
            },
            {
                label: "Help",
                submenu: [
                    { label: "Project Page", click: () => void shell.openExternal(PROJECT_URL) },
                    {
                        label: "About Unified Achievement Manager",
                        click: () =>
                            void dialog.showMessageBox({
                                title: "About Unified Achievement Manager",
                                message: `Unified Achievement Manager ${app.getVersion()}`,
                                detail: `Your data is stored in:\n${dataDir}`,
                            }),
                    },
                ],
            },
        ])
    );
}

async function start(): Promise<void> {
    captureLogs();
    console.log(`Starting Unified Achievement Manager ${app.getVersion()} (data: ${dataDir})`);
    buildMenu();
    // Windows attributes notifications (see #250) to this ID; it matches
    // electron-builder's appId so they show under the app's own name.
    if (process.platform === "win32") app.setAppUserModelId("io.github.therealestnwah.unifiedachievementmanager");

    // Nothing the dashboard does needs camera, notifications, geolocation, etc.
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));

    mainWindow = createWindow();
    mainWindow.on("closed", () => (mainWindow = null));

    // Tells the in-process server it's inside the desktop app, so the
    // dashboard offers the desktop-only settings (see #249).
    process.env.UAM_DESKTOP = "1";
    const { startApp } = require(serverEntry()) as { startApp(options: { dataDir: string }): Promise<RunningApp> };
    running = await startApp({ dataDir });
    appOrigin = new URL(running.url).origin;
    console.log(`Server ready at ${running.url}`);
    await mainWindow?.loadURL(running.url);

    // Skipped during the smoke test (see #195) - it boots and quits in
    // seconds, not worth spinning up an IPC connection attempt for.
    if (process.env.UAM_SMOKE_TEST !== "1") startDiscordPresence(running.url);
    if (process.env.UAM_SMOKE_TEST !== "1") {
        await startTray(running.url, () => mainWindow);
        startUnlockNotifications(running.url, () => mainWindow, unlockNotificationsEnabled);
    }

    // CI launches the packaged app with this set to prove it boots end to end.
    if (process.env.UAM_SMOKE_TEST === "1") {
        const ready = await fetch(`${running.url}/readyz`);
        const title = await mainWindow?.webContents.executeJavaScript("document.title");
        if (!ready.ok || !title) throw new Error(`Smoke test failed: readyz ${ready.status}, title ${JSON.stringify(title)}`);
        console.log(`Smoke test passed: readyz ${ready.status}, dashboard "${title}"`);
        app.quit();
    }
}

function stopServer(): Promise<void> {
    shutdown ??= Promise.all([stopDiscordPresence(), running ? running.stop() : Promise.resolve()])
        .then(() => undefined)
        .catch((err) => console.error("Shutdown failed:", err));
    return shutdown;
}

if (!app.requestSingleInstanceLock()) {
    // Another copy is already running against the same data folder and
    // database; hand focus to it instead of starting a second server.
    app.quit();
} else {
    // Also brings the window back from the tray.
    app.on("second-instance", () => showWindow(mainWindow));

    app.on("window-all-closed", () => app.quit());

    let readyToQuit = false;
    app.on("before-quit", (event) => {
        markQuitting();
        if (readyToQuit) return;
        event.preventDefault();
        stopTray();
        stopUnlockNotifications();
        void stopServer().finally(() => {
            readyToQuit = true;
            app.quit();
        });
    });

    app.whenReady()
        .then(start)
        .catch(async (err: unknown) => {
            console.error("Startup failed:", err);
            if (process.env.UAM_SMOKE_TEST !== "1") {
                dialog.showErrorBox(
                    "Unified Achievement Manager couldn't start",
                    `${err instanceof Error ? err.message : String(err)}\n\nDetails are in the log file:\n${logFile}`
                );
            }
            await stopServer();
            app.exit(1);
        });
}
