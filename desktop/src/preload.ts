import { contextBridge, ipcRenderer } from "electron";

// The few desktop-only actions the dashboard can start itself (see #496).
// Everything else the dashboard and the main process share goes through the
// local server, but an update check has to run in the main process.
contextBridge.exposeInMainWorld("uamDesktop", {
    platform: process.platform,
    automaticUpdatesSupported: process.platform !== "darwin",
    checkForUpdates: (): Promise<void> => ipcRenderer.invoke("uam:check-for-updates"),
    // Choosing the RPCS3 folder (see #522). Resolves to the folder's path, or
    // null when the dialog is cancelled.
    pickFolder: (title: string): Promise<string | null> => ipcRenderer.invoke("uam:pick-folder", title),
});
