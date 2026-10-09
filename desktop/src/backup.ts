import fs from "fs";
import path from "path";
import { execFile } from "child_process";

// Backing up and restoring the app's data from inside the app (see #295).
// The embedded PostgreSQL has to be stopped first so its files are
// consistent - callers stop the server, run one of these, then relaunch.
// Archives are .tar.gz made with the system tar (built into Windows 10+,
// macOS, and Linux), so there's no extra dependency to ship.

// Only the app's own files: the data folder is also Electron's userData, full
// of Chromium caches that are locked while the window is open.
export const BACKUP_ITEMS = ["secrets.json", "database.json", "app.json", "window-state.json", "postgres", "uploads"];
// secrets.json and postgres\ only work together; a backup without both is
// useless (or someone else's archive).
const REQUIRED = ["secrets.json", "database.json", path.join("postgres", "PG_VERSION")];

// On Windows, a "tar" found on PATH may be Git's GNU tar, which reads the
// "C:" in an archive path as a remote host; Windows' own bsdtar doesn't.
function tarCommand(): string {
    if (process.platform !== "win32") return "tar";
    return path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
}

function tar(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        execFile(tarCommand(), args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, _stdout, stderr) => {
            if (err) reject(new Error(`tar failed: ${stderr?.trim() || err.message}`));
            else resolve();
        });
    });
}

function datedName(kind: string, now: Date): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `Unified Achievement Manager ${kind} ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.tar.gz`;
}

export function defaultBackupName(now = new Date()): string {
    return datedName("backup", now);
}

export function defaultExportName(now = new Date()): string {
    return datedName("export", now);
}

export async function backupDataFolder(dataDir: string, archivePath: string): Promise<void> {
    const items = BACKUP_ITEMS.filter((item) => fs.existsSync(path.join(dataDir, item)));
    const partial = `${archivePath}.partial`;
    fs.rmSync(partial, { force: true });
    try {
        await tar(["-czf", partial, "-C", dataDir, ...items]);
        fs.renameSync(partial, archivePath);
    } catch (err) {
        fs.rmSync(partial, { force: true });
        throw err;
    }
}

export function missingBackupParts(folder: string): string[] {
    return REQUIRED.filter((part) => !fs.existsSync(path.join(folder, part)));
}

function timestamp(): string {
    return new Date().toISOString().replace(/[:.]/g, "-");
}

// Extracts into a scratch folder and checks it before touching anything, then
// moves the current app files into "<data folder>\before restore <time>"
// rather than deleting them, and moves the backup's files into place.
// Returns the folder the old files went to.
export async function restoreDataFolder(dataDir: string, archivePath: string): Promise<string> {
    const stamp = timestamp();
    const staging = path.join(dataDir, `restoring ${stamp}`);
    fs.mkdirSync(staging, { recursive: true });
    try {
        await tar(["-xzf", archivePath, "-C", staging]).catch((err: Error) => {
            throw new Error(`That file couldn't be opened as a backup (${err.message}).`);
        });
        const missing = missingBackupParts(staging);
        if (missing.length > 0) throw new Error(`That file isn't a Unified Achievement Manager backup (missing ${missing.join(", ")}).`);
    } catch (err) {
        fs.rmSync(staging, { recursive: true, force: true });
        throw err;
    }

    const previous = path.join(dataDir, `before restore ${stamp}`);
    fs.mkdirSync(previous, { recursive: true });
    const moved: string[] = [];
    const placed: string[] = [];
    try {
        for (const item of BACKUP_ITEMS) {
            if (!fs.existsSync(path.join(dataDir, item))) continue;
            fs.renameSync(path.join(dataDir, item), path.join(previous, item));
            moved.push(item);
        }
        for (const item of BACKUP_ITEMS) {
            if (!fs.existsSync(path.join(staging, item))) continue;
            fs.renameSync(path.join(staging, item), path.join(dataDir, item));
            placed.push(item);
        }
    } catch (err) {
        // Put everything back the way it was.
        for (const item of placed) fs.rmSync(path.join(dataDir, item), { recursive: true, force: true });
        for (const item of moved) fs.renameSync(path.join(previous, item), path.join(dataDir, item));
        fs.rmSync(previous, { recursive: true, force: true });
        throw err;
    } finally {
        fs.rmSync(staging, { recursive: true, force: true });
    }
    return previous;
}

// Exports (see #528) are the portable counterpart: the server writes the
// tables as JSON lines into a scratch folder, which is archived the same way.
// The server's functions are passed in because they live in its bundle.
export interface PortableData {
    exportPortableData(dataDir: string, outDir: string, appVersion: string): Promise<unknown>;
    importPortableData(dataDir: string, fromDir: string): Promise<string>;
}

export async function exportToArchive(portable: PortableData, dataDir: string, archivePath: string, appVersion: string): Promise<void> {
    const staging = path.join(dataDir, `exporting ${timestamp()}`);
    const partial = `${archivePath}.partial`;
    fs.rmSync(partial, { force: true });
    try {
        await portable.exportPortableData(dataDir, staging, appVersion);
        await tar(["-czf", partial, "-C", staging, "."]);
        fs.renameSync(partial, archivePath);
    } finally {
        fs.rmSync(partial, { force: true });
        fs.rmSync(staging, { recursive: true, force: true });
    }
}

// Returns the folder the replaced data went to.
export async function importFromArchive(portable: PortableData, dataDir: string, archivePath: string): Promise<string> {
    const staging = path.join(dataDir, `importing ${timestamp()}`);
    fs.mkdirSync(staging, { recursive: true });
    try {
        await tar(["-xzf", archivePath, "-C", staging]).catch((err: Error) => {
            throw new Error(`That file couldn't be opened as an export (${err.message}).`);
        });
        if (missingBackupParts(staging).length === 0) {
            throw new Error("That file is a backup, not an export. Use File → Restore from Backup… for it, on a computer of the same kind it was made on.");
        }
        return await portable.importPortableData(dataDir, staging);
    } finally {
        fs.rmSync(staging, { recursive: true, force: true });
    }
}
