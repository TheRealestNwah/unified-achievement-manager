import os from "os";
import path from "path";
import { startEmbeddedDatabase } from "./runtime/embeddedDatabase";
import { resolveAppPort } from "./runtime/appPort";

// Entry point for the self-contained app: no .env, no external PostgreSQL.
// Everything lives in one per-user data folder.

export function defaultDataDir(): string {
    if (process.platform === "win32") return path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "Unified Achievement Manager");
    if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "Unified Achievement Manager");
    return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "unified-achievement-manager");
}

export interface RunningApp {
    url: string;
    dataDir: string;
    stop(): Promise<void>;
}

export async function startApp({ dataDir = defaultDataDir(), port }: { dataDir?: string; port?: number } = {}): Promise<RunningApp> {
    const resolvedDataDir = path.resolve(dataDir);
    process.env.UAM_APP = "1";
    process.env.UAM_DATA_DIR = resolvedDataDir;
    process.env.PORT = String(port ?? (await resolveAppPort(resolvedDataDir)));

    const database = await startEmbeddedDatabase(resolvedDataDir);
    try {
        process.env.DATABASE_URL = database.url;

        // config.ts reads the environment when first imported, so nothing that
        // touches it may load before the variables above are in place.
        const { applySchema } = await import("./db/migrate");
        await applySchema();
        const { recomputeAllUserScores } = await import("./scoring");
        await recomputeAllUserScores();
        const { startServer } = await import("./index");
        const { config } = await import("./config");
        const server = await startServer();

        let stopping: Promise<void> | undefined;
        return {
            url: config.baseUrl,
            dataDir: resolvedDataDir,
            stop: () => (stopping ??= server.stop().finally(() => database.stop())),
        };
    } catch (err) {
        await database.stop().catch(() => undefined);
        throw err;
    }
}

// Running from source (npm run dev / npm run app). Uses its own data folder
// unless UAM_DATA_DIR says otherwise, so it never opens the installed app's
// database - which may well be running at the same time.
if (require.main === module) {
    startApp({ dataDir: process.env.UAM_DATA_DIR || path.join(__dirname, "..", ".dev-data"), port: Number(process.env.PORT) || 3000 })
        .then((app) => {
            console.log(`Unified Achievement Manager is running at ${app.url} (data in ${app.dataDir})`);
            const onSignal = () => {
                app.stop()
                    .catch((err) => {
                        console.error("Shutdown failed:", err);
                        process.exitCode = 1;
                    })
                    .finally(() => process.exit());
            };
            process.once("SIGINT", onSignal);
            process.once("SIGTERM", onSignal);
        })
        .catch((err) => {
            console.error(err);
            process.exit(1);
        });
}
