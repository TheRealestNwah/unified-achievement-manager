// Copies the compiled server into staging/server with production-only
// dependencies, ready for electron-builder's extraResources.
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverDir = path.resolve(desktopDir, "..", "server");
const stagingDir = path.join(desktopDir, "staging", "server");

if (!fs.existsSync(path.join(serverDir, "dist", "app.js"))) {
    throw new Error("server/dist/app.js is missing; run `npm run build:server` first");
}

fs.rmSync(stagingDir, { recursive: true, force: true });
fs.mkdirSync(stagingDir, { recursive: true });
for (const file of ["package.json", "package-lock.json"]) {
    fs.copyFileSync(path.join(serverDir, file), path.join(stagingDir, file));
}

// Run as a clean, standalone install: npm_config_* settings inherited from the
// outer `npm run` would otherwise leak in. Skip dependency scripts, then run
// only the PostgreSQL package's required symlink hydration below.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith("npm_config_")));
execSync("npm ci --omit=dev --ignore-scripts --no-audit --no-fund", { cwd: stagingDir, stdio: "inherit", env });

const pgPackage = path.join(stagingDir, "node_modules", "@embedded-postgres", `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`);
if (!fs.existsSync(pgPackage)) throw new Error(`Bundled PostgreSQL for this platform wasn't installed (${pgPackage})`);
// npm tarballs store PostgreSQL library symlinks in a manifest. macOS needs
// these restored before electron-builder copies the native libraries.
execFileSync(process.execPath, [path.join(pgPackage, "scripts", "hydrate-symlinks.js")], { cwd: pgPackage, stdio: "inherit", env });
const exe = process.platform === "win32" ? ".exe" : "";
for (const binary of ["initdb", "pg_ctl", "postgres"]) {
    fs.accessSync(path.join(pgPackage, "native", "bin", `${binary}${exe}`), fs.constants.X_OK);
}
console.log(`Staged server dependencies in ${stagingDir}`);
