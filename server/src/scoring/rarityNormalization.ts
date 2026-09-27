import { pool } from "../db";
import { resolveTierFromRarity, planPercentileTiers } from "./tier";

// Too few achievements for a percentile split to mean anything - a 3-item
// game would put its single rarest achievement alone in "gold" no matter
// how common it actually is. These just keep the fixed-threshold guess.
const MIN_SAMPLE_SIZE = 5;

// A game only needs the percentile correction when fixed thresholds actually
// break down for it - i.e. most of its list collapses into gold. Low median
// rarity alone doesn't mean that: Steam's overall completion rates run low
// across nearly every game (Half-Life 2's median is 7.1%, Portal's is 12%),
// so a median-based trigger flagged the vast majority of the library, not
// just true outliers. Measuring the actual gold share directly separates
// Payday 2 (93% gold under fixed thresholds - the case issue #10 was filed
// over) from ordinary games like Half-Life 2/Portal (~14%, left alone).
export const SKEW_GOLD_SHARE = 0.5;

// Re-resolves tier/points for every rarity_fallback achievement in one game,
// choosing between the fixed global thresholds and the per-game percentile
// split (see tier.ts) based on whether this game's own rarity distribution
// is skewed enough to make the fixed cutoffs meaningless (issue #10). Native
// PSN tiers and anything inherited via matching are untouched either way.
// Idempotent and safe to re-run - e.g. a game can un-skew as more
// achievements are synced in, and this will move it back to fixed
// thresholds just as readily as the other direction.
export async function normalizeRarityTiersForGame(gameId: string): Promise<boolean> {
    const rows = await pool.query(
        `select ca.id, ca.tier, ca.points,
                (select min(apl.global_unlock_rarity) from achievement_platform_links apl
                 where apl.canonical_achievement_id = ca.id) as rarity
         from canonical_achievements ca
         where ca.game_id = $1 and ca.tier_source = 'rarity_fallback'`,
        [gameId]
    );
    if (rows.rows.length === 0) return false;

    const achievements = rows.rows.map((r) => ({
        id: r.id as string,
        tier: r.tier as string,
        points: r.points as number,
        rarity: r.rarity != null ? Number(r.rarity) : undefined,
    }));

    const fixedResolved = achievements.map((a) => resolveTierFromRarity(a.rarity));
    const goldShare = fixedResolved.filter((r) => r.tier === "gold").length / fixedResolved.length;
    const isSkewed = achievements.length >= MIN_SAMPLE_SIZE && goldShare > SKEW_GOLD_SHARE;

    const resolved = isSkewed ? planPercentileTiers(achievements.map((a) => a.rarity)) : fixedResolved;

    let changed = false;
    for (let i = 0; i < achievements.length; i++) {
        const current = achievements[i];
        const next = resolved[i];
        if (next.tier !== current.tier || next.points !== current.points) {
            await pool.query("update canonical_achievements set tier = $1, points = $2 where id = $3", [
                next.tier,
                next.points,
                current.id,
            ]);
            changed = true;
        }
    }
    return changed;
}

export async function normalizeRarityTiersForAllGames(): Promise<{ gamesChanged: number }> {
    const games = await pool.query(
        "select distinct game_id from canonical_achievements where tier_source = 'rarity_fallback'"
    );

    let gamesChanged = 0;
    for (const row of games.rows) {
        if (await normalizeRarityTiersForGame(row.game_id)) gamesChanged++;
    }
    return { gamesChanged };
}
