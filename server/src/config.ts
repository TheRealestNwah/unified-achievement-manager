import dotenv from "dotenv";
import path from "path";
import { parseCredentialEncryptionKey } from "./security/credentials";
import { loadOrCreateSecrets } from "./runtime/secrets";

// The app (app.ts) never reads a .env: everything it needs is generated or
// passed in, so a stray .env in the working directory can't point it at some
// other database. Outside the app - the tests and db:* scripts - a .env can
// supply DATABASE_URL (see .env.example).
if (process.env.UAM_APP !== "1") dotenv.config();

// The one server mode is the single-user app (see #392): it only ever
// listens on this machine.
const HOST = "127.0.0.1";

// Where a from-source run keeps its data when nothing says otherwise - never
// the installed app's own folder, so the two can't share one database.
export const DEV_DATA_DIR = path.join(__dirname, "..", ".dev-data");

function required(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`Missing required env var: ${name}`);
    return value;
}

// Set by app.ts (and so by the desktop app) to the per-user data folder.
// Secrets are generated there on first run, and uploads live there.
const dataDir = path.resolve(process.env.UAM_DATA_DIR || DEV_DATA_DIR);
const secrets = loadOrCreateSecrets(dataDir);
const port = Number(process.env.PORT ?? 3000);

export const config = {
    port,
    host: HOST,
    // Must match the host the browser actually uses: session cookies for
    // localhost and 127.0.0.1 are separate, so a mismatched Steam return URL
    // would silently drop the login.
    baseUrl: `http://${HOST}:${port}`,
    dataDir,
    uploadsDir: path.join(dataDir, "uploads"),
    databaseUrl: required("DATABASE_URL"),
    sessionSecret: secrets.sessionSecret,
    credentialEncryptionKey: parseCredentialEncryptionKey(secrets.credentialEncryptionKey),
    // Loose: one person clicking around can't trip limits meant for a
    // shared public server, and nobody else can reach this one.
    rateLimitWindowMinutes: 15,
    rateLimitMaxRequests: 5000,
    authRateLimitMaxRequests: 300,
    // Until the user picks one under Settings -> Background sync.
    schedulerIntervalMinutes: 360,
};
