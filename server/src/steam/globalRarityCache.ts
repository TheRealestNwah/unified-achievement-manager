import { pool } from "../db";
import { getGlobalAchievementPercentages } from "./client";

// Global rarity shifts slowly (see #27) and this is the same data for every
// user who owns a given game, so it's cached app-wide rather than per account.
const GLOBAL_RARITY_TTL_MS = 24 * 60 * 60 * 1000;

export async function getCachedGlobalPercentages(appid: number): Promise<Map<string, number>> {
    const cached = await pool.query("select percentages, fetched_at from steam_global_rarity_cache where appid = $1", [appid]);
    if (cached.rows[0] && Date.now() - cached.rows[0].fetched_at.getTime() < GLOBAL_RARITY_TTL_MS) {
        return new Map(Object.entries(cached.rows[0].percentages));
    }

    const fresh = await getGlobalAchievementPercentages(appid);
    await pool.query(
        `insert into steam_global_rarity_cache (appid, percentages, fetched_at)
         values ($1, $2, now())
         on conflict (appid) do update set percentages = excluded.percentages, fetched_at = excluded.fetched_at`,
        [appid, JSON.stringify(Object.fromEntries(fresh))]
    );
    return fresh;
}
