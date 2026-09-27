import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireDataDirLock, DataDirInUseError, lockAddress } from "./dataDirLock";

let dataDir: string;

beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "uam-lock-"));
});

afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
});

// Holds the lock in a separate process, like a second running copy of the app.
function holdInChild(dir: string): Promise<{ kill(): Promise<void> }> {
    const script = `
        const net = require("net");
        const server = net.createServer((s) => s.destroy());
        server.listen(${JSON.stringify(lockAddress(dir))}, () => process.stdout.write("ready"));
    `;
    const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
    return new Promise((resolve, reject) => {
        child.once("error", reject);
        child.stdout.once("data", () =>
            resolve({
                // A hard kill, as a crash or Task Manager would.
                kill: () =>
                    new Promise<void>((done) => {
                        child.once("exit", () => done());
                        child.kill("SIGKILL");
                    }),
            })
        );
    });
}

describe("data folder lock (#405)", () => {
    it("refuses a second holder of the same folder until the first releases it", async () => {
        const first = await acquireDataDirLock(dataDir);
        await expect(acquireDataDirLock(dataDir)).rejects.toBeInstanceOf(DataDirInUseError);
        await first.release();
        const again = await acquireDataDirLock(dataDir);
        await again.release();
    });

    it("keeps different folders independent", async () => {
        const other = fs.mkdtempSync(path.join(os.tmpdir(), "uam-lock-"));
        try {
            const a = await acquireDataDirLock(dataDir);
            const b = await acquireDataDirLock(other);
            await Promise.all([a.release(), b.release()]);
        } finally {
            fs.rmSync(other, { recursive: true, force: true });
        }
    });

    it("refuses while another process holds it, and frees it when that process dies", async () => {
        const holder = await holdInChild(dataDir);
        await expect(acquireDataDirLock(dataDir)).rejects.toThrow(/already running/);
        await holder.kill();
        const lock = await acquireDataDirLock(dataDir);
        await lock.release();
    });
});
