import fs from "fs";
import net from "net";
import path from "path";
import { spawn } from "child_process";
import { randomBytes } from "crypto";
import { Client } from "pg";
import { acquireDataDirLock } from "./dataDirLock";

const DB_NAME = "uam";
const DB_USER = "uam";
const MAX_LOG_BYTES = 10 * 1024 * 1024;

interface Binaries {
    pg_ctl: string;
    initdb: string;
}

export interface EmbeddedDatabase {
    url: string;
    stop(): Promise<void>;
}

// Each @embedded-postgres/<platform>-<arch> package ships the PostgreSQL
// binaries under native/bin next to its (ESM-only) entry point, which does
// nothing but compute these same paths.
function loadBinaries(): Binaries {
    const platform = process.platform === "win32" ? "windows" : process.platform;
    const pkg = `@embedded-postgres/${platform}-${process.arch}`;
    let entry: string;
    try {
        entry = require.resolve(pkg);
    } catch {
        throw new Error(`No bundled PostgreSQL build for ${process.platform}-${process.arch} (${pkg} is not installed)`);
    }
    const binDir = path.join(path.dirname(entry), "..", "native", "bin");
    const exe = process.platform === "win32" ? ".exe" : "";
    return { pg_ctl: path.join(binDir, `pg_ctl${exe}`), initdb: path.join(binDir, `initdb${exe}`) };
}

function run(command: string, args: string[], { capture = true } = {}): Promise<{ code: number | null; output: string }> {
    return new Promise((resolve, reject) => {
        // pg_ctl start leaves postgres running with our inherited pipes open, so
        // it gets no pipes at all and we wait on "exit" rather than "close".
        const child = spawn(command, args, { stdio: capture ? ["ignore", "pipe", "pipe"] : "ignore", windowsHide: true });
        let output = "";
        child.stdout?.on("data", (chunk) => (output += chunk));
        child.stderr?.on("data", (chunk) => (output += chunk));
        child.on("error", reject);
        child.on(capture ? "close" : "exit", (code) => resolve({ code, output }));
    });
}

async function runOrThrow(command: string, args: string[], what: string, options?: { capture?: boolean }): Promise<void> {
    const { code, output } = await run(command, args, options);
    if (code !== 0) throw new Error(`${what} failed (exit ${code})${output ? `: ${output.trim()}` : ""}`);
}

export function findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.on("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address() as net.AddressInfo;
            server.close(() => resolve(port));
        });
    });
}

function loadOrCreatePassword(dataDir: string): string {
    const file = path.join(dataDir, "database.json");
    if (fs.existsSync(file)) {
        const { password } = JSON.parse(fs.readFileSync(file, "utf8")) as { password?: unknown };
        if (typeof password !== "string" || !password) throw new Error(`${file} is malformed`);
        return password;
    }
    const password = randomBytes(24).toString("hex");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ password }, null, 2), { mode: 0o600 });
    return password;
}

// initdb runs into a scratch directory that is only renamed into place once
// it succeeds, so an interrupted first launch can simply be retried.
async function initCluster(bins: Binaries, dataDir: string, pgData: string, password: string): Promise<void> {
    const scratch = `${pgData}.init`;
    const pwFile = path.join(dataDir, "initdb-password.tmp");
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.writeFileSync(pwFile, `${password}\n`, { mode: 0o600 });
    try {
        await runOrThrow(
            bins.initdb,
            [
                `--pgdata=${scratch}`,
                `--username=${DB_USER}`,
                `--pwfile=${pwFile}`,
                "--auth=scram-sha-256",
                "--encoding=UTF8",
                // Built-in provider (PostgreSQL 17+): Unicode-aware and identical
                // on every machine, unlike whatever the OS locale happens to be.
                "--locale-provider=builtin",
                "--builtin-locale=C.UTF-8",
                "--locale=C",
            ],
            "Initialising the database"
        );
    } finally {
        fs.rmSync(pwFile, { force: true });
    }
    fs.appendFileSync(
        path.join(scratch, "postgresql.conf"),
        "\n# Added by Unified Achievement Manager: reachable from this computer only.\nlisten_addresses = '127.0.0.1'\nunix_socket_directories = ''\n"
    );
    fs.renameSync(scratch, pgData);
}

async function isRunning(bins: Binaries, pgData: string): Promise<boolean> {
    const { code } = await run(bins.pg_ctl, ["status", `--pgdata=${pgData}`]);
    return code === 0;
}

async function stopCluster(bins: Binaries, pgData: string): Promise<void> {
    if (!(await isRunning(bins, pgData))) return;
    await runOrThrow(bins.pg_ctl, ["stop", `--pgdata=${pgData}`, "--mode=fast", "--wait", "--timeout=60"], "Stopping the database");
}

function trimLog(logFile: string): void {
    try {
        if (fs.statSync(logFile).size > MAX_LOG_BYTES) fs.rmSync(logFile);
    } catch {
        // No log yet.
    }
}

async function ensureDatabase(port: number, password: string): Promise<void> {
    const client = new Client({ host: "127.0.0.1", port, user: DB_USER, password, database: "postgres" });
    await client.connect();
    try {
        const exists = await client.query("select 1 from pg_database where datname = $1", [DB_NAME]);
        if (!exists.rows[0]) await client.query(`create database ${DB_NAME}`);
    } finally {
        await client.end();
    }
}

export async function startEmbeddedDatabase(dataDir: string): Promise<EmbeddedDatabase> {
    const bins = loadBinaries();
    // Taken before anything below can stop a PostgreSQL that's in use, and
    // held until this database is stopped (see #405).
    const lock = await acquireDataDirLock(dataDir);
    try {
        return await startCluster(bins, dataDir, lock);
    } catch (err) {
        await lock.release();
        throw err;
    }
}

async function startCluster(bins: Binaries, dataDir: string, lock: { release(): Promise<void> }): Promise<EmbeddedDatabase> {
    const pgData = path.join(dataDir, "postgres");
    const logFile = path.join(dataDir, "postgres.log");
    const password = loadOrCreatePassword(dataDir);

    if (!fs.existsSync(path.join(pgData, "PG_VERSION"))) await initCluster(bins, dataDir, pgData, password);

    // A previous run that crashed (or was killed) can leave its postgres
    // behind holding the data directory; it's ours, so shut it down cleanly.
    await stopCluster(bins, pgData);
    trimLog(logFile);

    let port: number;
    for (let attempt = 1; ; attempt++) {
        port = await findFreePort();
        const { code } = await run(
            bins.pg_ctl,
            ["start", `--pgdata=${pgData}`, `--log=${logFile}`, "--wait", "--timeout=120", `--options=-p ${port}`],
            { capture: false }
        );
        if (code === 0) break;
        // Most likely something grabbed the port between probing and binding.
        if (attempt === 3) throw new Error(`The database failed to start; see ${logFile}`);
    }

    await ensureDatabase(port, password);

    return {
        url: `postgres://${DB_USER}:${encodeURIComponent(password)}@127.0.0.1:${port}/${DB_NAME}`,
        stop: () => stopCluster(bins, pgData).finally(() => lock.release()),
    };
}
