import { pool } from "../db";

export interface NewUnlocksFeed {
    // Every unlock recorded after `since`, however many.
    total: number;
    // The oldest few of them, for naming in a notification.
    unlocks: { name: string; tier: string; game_title: string; platform_id: string }[];
    platinums: { name: string; game_title: string }[];
    level: number | null;
    // Pass back as `since` next time.
    cursor: string;
}

// Unlocks the app has recorded since `since` (by recorded_at, not the
// platform's own unlocked_at - a first sync imports old unlocks), for the
// desktop app's notifications (see #250). Single-user app, so no user scope;
// excluded games are left out like everywhere else they're "removed".
// `since` stays a string end to end: recorded_at has microseconds, and a JS
// Date would truncate them, making the latest unlock look new again.
export async function getNewUnlocksSince(since: string, sampleSize = 5): Promise<NewUnlocksFeed> {
    const base = `
        from user_achievement_unlocks uau
        join achievement_platform_links apl on apl.id = uau.achievement_platform_link_id
        join canonical_achievements ca on ca.id = apl.canonical_achievement_id
        join games g on g.id = ca.game_id
        join user_platform_accounts upa on upa.id = uau.user_platform_account_id
        where uau.recorded_at > $1::timestamptz
          and not exists (
              select 1 from user_game_visibility ugv
              where ugv.user_id = upa.user_id and ugv.game_id = g.id and ugv.mode = 'excluded'
          )`;
    const summary = await pool.query(
        `select count(*) as total,
                to_char(max(uau.recorded_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as latest
         ${base}`,
        [since]
    );
    const sample = await pool.query(
        `select ca.name, ca.tier, g.title as game_title, apl.platform_id ${base} order by uau.recorded_at, ca.name limit $2`,
        [since, sampleSize]
    );
    const platinums = await pool.query(
        `select ca.name, g.title as game_title ${base} and ca.tier = 'platinum' order by uau.recorded_at limit $2`,
        [since, sampleSize]
    );
    const score = await pool.query("select level from user_scores order by computed_at desc limit 1");
    const latest: string | null = summary.rows[0].latest;
    return {
        total: Number(summary.rows[0].total),
        unlocks: sample.rows,
        platinums: platinums.rows,
        level: score.rows[0] ? Number(score.rows[0].level) : null,
        cursor: latest ?? since,
    };
}
