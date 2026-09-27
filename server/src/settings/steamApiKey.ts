import { config } from "../config";
import { pool } from "../db";
import { configureSteamStrategy } from "../auth/passport";
import { decryptCredential, encryptCredential } from "../security/credentials";

const SETTING_KEY = "steam_api_key";
// Any public Steam ID works; this one (Valve's Robin Walker) is stable.
const PROBE_STEAM_ID = "76561197960435530";

let currentKey: string | undefined;

export function hasSteamApiKey(): boolean {
    return currentKey !== undefined;
}

export function getSteamApiKey(): string {
    if (!currentKey) throw new Error("No Steam Web API key is configured yet");
    return currentKey;
}

function useKey(apiKey: string): void {
    currentKey = apiKey;
    configureSteamStrategy(apiKey);
}

export async function loadSteamApiKey(): Promise<void> {
    const result = await pool.query("select value from app_settings where key = $1", [SETTING_KEY]);
    if (result.rows[0]) useKey(decryptCredential(result.rows[0].value as string, config.credentialEncryptionKey));
}

// Steam answers 403 for an unknown key, which is the only way to tell a typo
// apart from a real key before the user gets bounced out of sign-in.
export async function isValidSteamApiKey(apiKey: string): Promise<boolean> {
    const url = new URL("https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/");
    url.searchParams.set("key", apiKey);
    url.searchParams.set("steamids", PROBE_STEAM_ID);
    const res = await fetch(url);
    if (res.status === 401 || res.status === 403) return false;
    if (!res.ok) throw new Error(`Steam didn't respond (${res.status}); try again in a moment`);
    return true;
}

export async function saveSteamApiKey(apiKey: string): Promise<void> {
    await pool.query(
        `insert into app_settings (key, value) values ($1, $2)
         on conflict (key) do update set value = excluded.value, updated_at = now()`,
        [SETTING_KEY, encryptCredential(apiKey, config.credentialEncryptionKey)]
    );
    useKey(apiKey);
}
