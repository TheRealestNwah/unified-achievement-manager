import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { startEmbeddedDatabase } from "./embeddedDatabase";

const enabled = process.env.EMBEDDED_PG_TESTS === "true";
const suite = enabled ? describe : describe.skip;

async function query<T>(url: string, sql: string): Promise<T[]> {
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
        return (await client.query(sql)).rows as T[];
    } finally {
        await client.end();
    }
}

suite("embedded PostgreSQL", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "uam-embedded-pg-"));

    afterAll(() => {
        fs.rmSync(dataDir, { recursive: true, force: true });
    });

    it("initialises a cluster on first start and keeps data across restarts", async () => {
        const first = await startEmbeddedDatabase(dataDir);
        try {
            const [{ version }] = await query<{ version: string }>(first.url, "select current_setting('server_version') as version");
            expect(version).toMatch(/^17\./);
            const [{ listen }] = await query<{ listen: string }>(first.url, "select current_setting('listen_addresses') as listen");
            expect(listen).toBe("127.0.0.1");
            await query(first.url, "create table persisted (value text); insert into persisted values ('kept')");
        } finally {
            await first.stop();
        }

        const second = await startEmbeddedDatabase(dataDir);
        try {
            expect(await query(second.url, "select value from persisted")).toEqual([{ value: "kept" }]);
        } finally {
            await second.stop();
        }
    }, 180_000);

    it("refuses to start on a folder whose database another live run is using (#405)", async () => {
        const running = await startEmbeddedDatabase(dataDir);
        try {
            await expect(startEmbeddedDatabase(dataDir)).rejects.toThrow(/already running/);
            // The running one's database was left alone.
            expect(await query(running.url, "select value from persisted")).toEqual([{ value: "kept" }]);
        } finally {
            await running.stop();
        }
    }, 180_000);

    it("recovers when a previous run crashed without stopping its database", async () => {
        // Start the database from a separate process, then kill that process
        // outright: its PostgreSQL keeps running with no owner, as after a crash.
        const script = `require("ts-node/register/transpile-only");
            require(${JSON.stringify(path.join(__dirname, "embeddedDatabase.ts"))})
                .startEmbeddedDatabase(${JSON.stringify(dataDir)})
                .then((db) => process.stdout.write(db.url));`;
        const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
        const orphanedUrl = await new Promise<string>((resolve, reject) => {
            child.once("error", reject);
            child.stdout.once("data", (chunk) => resolve(String(chunk)));
        });
        await new Promise<void>((resolve) => {
            child.once("exit", () => resolve());
            child.kill("SIGKILL");
        });
        expect(await query(orphanedUrl, "select 1 as ok")).toEqual([{ ok: 1 }]);

        const restarted = await startEmbeddedDatabase(dataDir);
        try {
            expect(await query(restarted.url, "select value from persisted")).toEqual([{ value: "kept" }]);
            await expect(query(orphanedUrl, "select 1")).rejects.toThrow();
        } finally {
            await restarted.stop();
        }
    }, 180_000);
});
