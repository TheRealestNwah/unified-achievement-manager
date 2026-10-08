// Mount the DMG, copy its app to an isolated install folder, then launch twice
// against scratch data. No installed app or real platform credentials are used.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

assert.equal(process.platform, "darwin", "This smoke test must run on macOS");
const dmg = path.resolve(process.argv[2] ?? "");
assert.ok(dmg.endsWith(".dmg") && fs.existsSync(dmg), "Pass a built DMG path");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "uam-mac-smoke-"));
const mount = path.join(work, "mount");
const data = path.join(work, "data");
const installed = path.join(work, "Unified Achievement Manager.app");
const logs = path.resolve("release", "smoke-macos");
const pgCtl = path.join(installed, "Contents", "Resources", "server", "node_modules", "@embedded-postgres", `darwin-${process.arch}`, "native", "bin", "pg_ctl");
let mounted = false;
let child;
fs.mkdirSync(mount);
fs.mkdirSync(logs, { recursive: true });

async function launch(pass) {
    const exe = path.join(installed, "Contents", "MacOS", "Unified Achievement Manager");
    let output = "";
    child = spawn(exe, [], {
        env: { ...process.env, UAM_DATA_DIR: data, UAM_SMOKE_TEST: "1", UAM_SMOKE_SCREENSHOT: path.join(logs, `dashboard-${pass}.png`) },
        stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("App did not quit within 3 minutes")); }, 180_000);
        child.once("error", err => { clearTimeout(timer); reject(err); });
        child.once("exit", code => { clearTimeout(timer); resolve(code); });
    });
    fs.writeFileSync(path.join(logs, `process-${pass}.log`), output);
    assert.equal(code, 0, output);
    const log = fs.readFileSync(path.join(data, "logs", "main.log"), "utf8");
    assert.equal((log.match(/Smoke test passed: readyz/g) ?? []).length, pass);
    assert.ok(log.includes("Mac window lifecycle passed"));
    assert.ok(!fs.existsSync(path.join(data, "postgres", "postmaster.pid")), "PostgreSQL still running after quit");
    const lock = fs.readdirSync(data).filter(name => name.endsWith(".lock"));
    assert.deepEqual(lock, [], "Data directory lock remains after quit");
    console.log(`Packaged Mac launch ${pass} passed`);
}

try {
    execFileSync("hdiutil", ["attach", dmg, "-readonly", "-nobrowse", "-mountpoint", mount], { stdio: "inherit" });
    mounted = true;
    execFileSync("ditto", [path.join(mount, "Unified Achievement Manager.app"), installed]);
    execFileSync("hdiutil", ["detach", mount], { stdio: "inherit" });
    mounted = false;
    await launch(1);
    const password = fs.readFileSync(path.join(data, "database.json"), "utf8");
    const secrets = fs.readFileSync(path.join(data, "secrets.json"), "utf8");
    await launch(2);
    assert.equal(fs.readFileSync(path.join(data, "database.json"), "utf8"), password, "Database identity changed on relaunch");
    assert.equal(fs.readFileSync(path.join(data, "secrets.json"), "utf8"), secrets, "Secrets changed on relaunch");
    fs.rmSync(installed, { recursive: true, force: true });
    assert.ok(fs.existsSync(path.join(data, "postgres", "PG_VERSION")), "Removing the app removed user data");
    console.log("Mac smoke test passed: DMG install, first launch, relaunch, clean quit, remove app, preserve data");
} finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (fs.existsSync(pgCtl) && fs.existsSync(path.join(data, "postgres", "PG_VERSION"))) {
        try { execFileSync(pgCtl, ["stop", `--pgdata=${path.join(data, "postgres")}`, "--mode=fast", "--wait"], { stdio: "inherit" }); } catch { /* Already stopped. */ }
    }
    if (fs.existsSync(data)) fs.cpSync(data, path.join(logs, "data"), { recursive: true });
    if (mounted) execFileSync("hdiutil", ["detach", mount], { stdio: "inherit" });
    fs.rmSync(work, { recursive: true, force: true });
}
