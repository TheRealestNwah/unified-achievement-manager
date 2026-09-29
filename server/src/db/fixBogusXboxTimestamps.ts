import { pool } from "../db";

// One-off correction for data written before the timeUnlocked sanitization
// fix in xbox/client.ts's getX360AchievementsForTitle: some legacy Xbox 360
// unlocks were recorded with a bogus sentinel timestamp (seen: 1752-12-31,
// centuries before Xbox existed) instead of a real unlock time. The client
// fix only prevents this going forward - recordUnlock's ON CONFLICT DO
// NOTHING means already-recorded rows are never touched by a normal
// re-sync. See #41. Safe to re-run - a no-op once corrected.
const XBOX_360_LAUNCH = "2005-11-22";

async function fixBogusXboxTimestamps() {
    const result = await pool.query(
        `update user_achievement_unlocks uau
         set unlocked_at = null
         from achievement_platform_links apl
         where apl.id = uau.achievement_platform_link_id
           and apl.platform_id = 'xbox'
           and uau.unlocked_at < $1
         returning uau.id`,
        [XBOX_360_LAUNCH]
    );

    console.log(`Corrected ${result.rows.length} bogus Xbox unlock timestamp(s).`);
    await pool.end();
}

fixBogusXboxTimestamps().catch((err) => {
    console.error(err);
    process.exit(1);
});
