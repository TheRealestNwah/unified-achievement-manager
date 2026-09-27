import { pool } from "../db";
import { getGameCompletionCountsForUser } from "../games/queries";
import { TIER_POINTS, qualifiesForCompletionPlatinum } from "./tier";

export interface UserScore {
    totalPoints: number;
    level: number;
    pointsForCurrentLevel: number;
    pointsForNextLevel: number | null; // null once MAX_LEVEL is reached
}

// Recomputes a user's total points from every one of their unlocks, counted
// per platform - the same real-world achievement earned separately on two
// linked platforms (e.g. platinumed on PSN, separately 100%ed on Steam)
// counts twice, matching how the games list already sums each platform's
// own totals rather than deduping by canonical achievement. Call this after
// any sync that adds unlocks.
export async function recomputeUserScore(userId: string): Promise<UserScore> {
    const totalResult = await pool.query(
        `select coalesce(sum(ca.points), 0) as total
         from user_achievement_unlocks uau
         join user_platform_accounts upa on upa.id = uau.user_platform_account_id
         join achievement_platform_links apl on apl.id = uau.achievement_platform_link_id
         join canonical_achievements ca on ca.id = apl.canonical_achievement_id
         where upa.user_id = $1
           -- A game the user excluded (see #192, user_game_visibility) has
           -- its points subtracted from the user's score - unlike a merely
           -- "hidden" game, which is left out of the library view but still
           -- counts here.
           and not exists (
               select 1 from user_game_visibility ugv
               where ugv.user_id = $1 and ugv.game_id = ca.game_id and ugv.mode = 'excluded'
           )`,
        [userId]
    );
    const achievementPoints = Number(totalResult.rows[0].total);

    // Synthetic completion platinums (see scoring/tier.ts, #145) aren't real
    // canonical_achievements rows, so they never show up in the sum above -
    // add their points here so a 100%-complete Steam/Xbox/GOG/
    // RetroAchievements game (or a psn_native game without its own platinum
    // row) credits the user the same TIER_POINTS.platinum a real platinum
    // would, keeping level/points consistent with what getGamesForUser and
    // getFunStats now display for that game.
    const completionCounts = await getGameCompletionCountsForUser(userId);
    const completionPlatinumBonus =
        completionCounts.filter(qualifiesForCompletionPlatinum).length * TIER_POINTS.platinum;
    const totalPoints = achievementPoints + completionPlatinumBonus;

    const levelResult = await pool.query(
        "select level from level_thresholds where points_required <= $1 order by level desc limit 1",
        [totalPoints]
    );
    const level = levelResult.rows[0]?.level ?? 1;

    await pool.query(
        `insert into user_scores (user_id, total_points, level, computed_at)
         values ($1, $2, $3, now())
         on conflict (user_id) do update
            set total_points = excluded.total_points,
                level = excluded.level,
                computed_at = excluded.computed_at`,
        [userId, totalPoints, level]
    );

    return getScoreBreakdown(totalPoints, level);
}

export async function getUserScore(userId: string): Promise<UserScore> {
    const result = await pool.query(
        "select total_points, level from user_scores where user_id = $1",
        [userId]
    );
    if (!result.rows[0]) return getScoreBreakdown(0, 1);
    return getScoreBreakdown(Number(result.rows[0].total_points), result.rows[0].level);
}

async function getScoreBreakdown(totalPoints: number, level: number): Promise<UserScore> {
    const currentThreshold = await pool.query(
        "select points_required from level_thresholds where level = $1",
        [level]
    );
    const nextThreshold = await pool.query(
        "select points_required from level_thresholds where level = $1",
        [level + 1]
    );
    return {
        totalPoints,
        level,
        pointsForCurrentLevel: Number(currentThreshold.rows[0]?.points_required ?? 0),
        pointsForNextLevel: nextThreshold.rows[0] ? Number(nextThreshold.rows[0].points_required) : null,
    };
}

// Every user's score, from scratch. The desktop app runs this at startup
// (see #356) so an update that changes how points are counted shows up in
// the level straight away, not only after the next sync.
export async function recomputeAllUserScores(): Promise<void> {
    const users = await pool.query("select id from users");
    for (const user of users.rows) await recomputeUserScore(user.id);
}
