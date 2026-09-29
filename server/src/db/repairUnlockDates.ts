import { pool } from "../db";

const DONE_KEY = "repaired_unknown_unlock_dates";

// Before #423, an unlock the platform gave no time for was stamped with the
// sync's own time (or, for Steam, 1970), and 1752 sentinels from Xbox 360
// could slip in before #41. This clears those to "date unknown" once per data
// folder:
//   - anything before 2000, which predates every platform's achievements;
//   - bursts where one account "unlocked" achievements in three or more
//     different games within about 20 seconds. Nobody plays like that; a
//     sync writing a fallback time for each game it walks through does.
export async function repairUnknownUnlockDates(): Promise<number> {
    const done = await pool.query("select 1 from app_settings where key = $1", [DONE_KEY]);
    if (done.rows[0]) return 0;

    const client = await pool.connect();
    try {
        await client.query("begin");
        // Two 20-second grids offset by 10 seconds: any unlocks within 10
        // seconds of each other share a bucket in at least one of them, and
        // it stays one pass over the table however big the library is.
        const result = await client.query(`
            with u as (
                select uau.id, uau.user_platform_account_id as account, apl.platform_game_id as game, uau.unlocked_at,
                       floor(extract(epoch from uau.unlocked_at) / 20) as grid_a,
                       floor((extract(epoch from uau.unlocked_at) + 10) / 20) as grid_b
                from user_achievement_unlocks uau
                join achievement_platform_links apl on apl.id = uau.achievement_platform_link_id
                where uau.unlocked_at is not null
            ),
            bursts_a as (select account, grid_a from u group by account, grid_a having count(distinct game) >= 3),
            bursts_b as (select account, grid_b from u group by account, grid_b having count(distinct game) >= 3),
            bogus as (
                select id from u where unlocked_at < '2000-01-01'
                union
                select u.id from u join bursts_a using (account, grid_a)
                union
                select u.id from u join bursts_b using (account, grid_b)
            )
            update user_achievement_unlocks set unlocked_at = null
            where id in (select id from bogus)
        `);
        await client.query("insert into app_settings (key, value) values ($1, 'true') on conflict (key) do nothing", [DONE_KEY]);
        await client.query("commit");
        if (result.rowCount) console.log(`Cleared ${result.rowCount} unlock date(s) that were sync times, not real ones.`);
        return result.rowCount ?? 0;
    } catch (err) {
        await client.query("rollback");
        throw err;
    } finally {
        client.release();
    }
}
