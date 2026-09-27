import { pool } from "../db";
import type { SteamIdentity } from "./passport";

export class SteamLinkError extends Error {}

// Links the Steam account the user just proved is theirs to their profile.
// A database from before #393 may still have it on another user row (someone
// who once signed in with a second Steam account); with one profile per app,
// it moves over, bringing its synced data along.
export async function linkSteamAccount(userId: string, identity: SteamIdentity): Promise<void> {
    const current = await pool.query("select platform_account_id from user_platform_accounts where user_id = $1 and platform_id = 'steam'", [
        userId,
    ]);
    if (current.rows[0]) {
        if (current.rows[0].platform_account_id === identity.steamId) return;
        throw new SteamLinkError("A different Steam account is already connected. Disconnect it first.");
    }
    await pool.query(
        `insert into user_platform_accounts (user_id, platform_id, platform_account_id, display_name)
         values ($1, 'steam', $2, $3)
         on conflict (platform_id, platform_account_id) do update set user_id = excluded.user_id, display_name = excluded.display_name`,
        [userId, identity.steamId, identity.displayName]
    );
}
