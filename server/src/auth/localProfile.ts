import type { PoolClient } from "pg";
import { pool } from "../db";

// The app has one user, the local profile (see #393). Nobody signs in: a
// request without a session is signed in as this profile (signInLocalProfile
// below). Signing in with Steam used to create the user; now Steam is just a
// platform linked to it.
const SETTING_KEY = "local_profile_user_id";

// Stops two first-run requests from both creating a profile.
const CREATE_LOCK = 393_001;

export const MAX_DISPLAY_NAME_LENGTH = 50;

async function findLocalProfile(db: Pick<PoolClient, "query">): Promise<Express.User | null> {
    const saved = await db.query(
        "select u.* from app_settings s join users u on u.id::text = s.value where s.key = $1",
        [SETTING_KEY]
    );
    if (saved.rows[0]) return saved.rows[0];

    // Databases from before #393 have users but no saved profile - normally
    // exactly one. If someone did sign in with two Steam accounts, the one
    // most recently signed in is the one they were using.
    const existing = await db.query(`
        select u.* from users u
        left join lateral (
            select max(s.expire) as last_seen from session s where s.sess #>> '{passport,user}' = u.id::text
        ) seen on true
        order by seen.last_seen desc nulls last, u.created_at desc
        limit 1
    `);
    if (!existing.rows[0]) return null;
    await saveLocalProfile(db, existing.rows[0].id);
    return existing.rows[0];
}

async function saveLocalProfile(db: Pick<PoolClient, "query">, userId: string): Promise<void> {
    await db.query(
        `insert into app_settings (key, value) values ($1, $2)
         on conflict (key) do update set value = excluded.value, updated_at = now()`,
        [SETTING_KEY, userId]
    );
}

export function getLocalProfile(): Promise<Express.User | null> {
    return findLocalProfile(pool);
}

export class ProfileExistsError extends Error {}

export async function createLocalProfile(displayName: string): Promise<Express.User> {
    const client = await pool.connect();
    try {
        await client.query("begin");
        await client.query("select pg_advisory_xact_lock($1)", [CREATE_LOCK]);
        if (await findLocalProfile(client)) throw new ProfileExistsError("A profile already exists");
        const user = (await client.query("insert into users (username) values ($1) returning *", [displayName])).rows[0];
        await saveLocalProfile(client, user.id);
        await client.query("commit");
        return user;
    } catch (err) {
        await client.query("rollback");
        throw err;
    } finally {
        client.release();
    }
}
