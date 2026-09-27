import fs from "fs";
import net from "net";
import path from "path";
import { createHash } from "crypto";

// Only one process may run the app on a data folder at a time (see #405).
// Starting up stops any PostgreSQL still running on the folder, assuming a
// crash left it behind; without this lock, a second copy (npm run app with
// UAM_DATA_DIR pointed at the installed app's folder, say) would shut down
// the database under an app that's still running.
//
// The lock is a listening named pipe (a Unix socket elsewhere), so the OS
// releases it the moment the owning process exits, crash included - there's
// no stale lock file to second-guess.

export class DataDirInUseError extends Error {}

export interface DataDirLock {
    release(): Promise<void>;
}

export function lockAddress(dataDir: string): string {
    const resolved = path.resolve(dataDir);
    if (process.platform === "win32") {
        // Pipe names are global, so key on the folder (case-insensitively, as
        // Windows paths are).
        const hash = createHash("sha256").update(resolved.toLowerCase()).digest("hex").slice(0, 32);
        return `\\\\.\\pipe\\unified-achievement-manager-${hash}`;
    }
    return path.join(resolved, "app.lock");
}

function listen(address: string): Promise<net.Server> {
    return new Promise((resolve, reject) => {
        const server = net.createServer((socket) => socket.destroy());
        server.once("error", reject);
        server.listen(address, () => {
            server.off("error", reject);
            // Never keeps the process alive on its own.
            server.unref();
            resolve(server);
        });
    });
}

function isAnswering(address: string): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = net.connect(address);
        socket.once("connect", () => {
            socket.destroy();
            resolve(true);
        });
        socket.once("error", () => resolve(false));
    });
}

export async function acquireDataDirLock(dataDir: string): Promise<DataDirLock> {
    const address = lockAddress(dataDir);
    fs.mkdirSync(path.resolve(dataDir), { recursive: true });
    let server: net.Server;
    try {
        server = await listen(address);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
        // A Unix socket file outlives a crashed owner; if nothing answers on
        // it, it's stale.
        if (process.platform !== "win32" && !(await isAnswering(address))) {
            fs.rmSync(address, { force: true });
            server = await listen(address);
        } else {
            throw new DataDirInUseError(
                `Another copy of Unified Achievement Manager is already running on ${path.resolve(dataDir)}. Close it first.`
            );
        }
    }
    let released: Promise<void> | undefined;
    return {
        release: () => (released ??= new Promise<void>((resolve) => server.close(() => resolve()))),
    };
}
