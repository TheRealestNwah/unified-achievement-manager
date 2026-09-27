import { pool } from "../db";

export class DifferentAccountError extends Error {
    constructor(platformLabel: string, existingName: string | null) {
        super(
            `That's a different ${platformLabel} account than the one already connected${existingName ? ` (${existingName})` : ""}. ` +
                "Disconnect it first to switch accounts."
        );
    }
}

// Re-entering a key or token for an already-connected platform updates that
// account in place and keeps everything synced from it (see #283) - but only
// for the same platform account. Swapping in a different one would leave the
// old account's games and unlocks attributed to the new one.
export async function assertSameAccountOnReconnect(
    userId: string,
    platformId: string,
    platformAccountId: string,
    platformLabel: string
): Promise<void> {
    const existing = await pool.query(
        "select platform_account_id, display_name from user_platform_accounts where user_id = $1 and platform_id = $2",
        [userId, platformId]
    );
    const row = existing.rows[0];
    if (row && row.platform_account_id !== platformAccountId) throw new DifferentAccountError(platformLabel, row.display_name);
}

// A fresh key or token supersedes whatever made the last sync fail.
export async function clearSyncError(userId: string, platformId: string): Promise<void> {
    await pool.query(
        "update user_platform_accounts set last_sync_error = null, last_sync_error_at = null where user_id = $1 and platform_id = $2",
        [userId, platformId]
    );
}
