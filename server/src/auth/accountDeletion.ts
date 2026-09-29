import { pool } from "../db";
import { deleteUploadedFiles } from "../games/uploads";

export interface AccountDeletionResult {
    fileCleanupPending: boolean;
}

// Deletes all account-scoped database data through the existing foreign-key
// cascades. Canonical games and achievements deliberately remain: they can be
// shared by other users and do not belong to one account.
export async function deleteUserAccount(userId: string): Promise<AccountDeletionResult> {
    const client = await pool.connect();
    let uploadedUrls: string[];

    try {
        await client.query("begin");
        const [covers, icons] = await Promise.all([
            client.query("select cover_image_url from user_game_cover_overrides where user_id = $1 for update", [userId]),
            client.query("select icon_url from user_achievement_icon_overrides where user_id = $1 for update", [userId]),
        ]);
        uploadedUrls = [...covers.rows.map((row) => row.cover_image_url), ...icons.rows.map((row) => row.icon_url)];

        // connect-pg-simple stores Passport's serialized user ID under
        // sess.passport.user. Clearing every matching row revokes sessions
        // on other browsers as well as the one making this request.
        await client.query("delete from session where sess #>> '{passport,user}' = $1", [userId]);
        const deleted = await client.query("delete from users where id = $1 returning id", [userId]);
        if (!deleted.rows[0]) throw new Error("Account not found");
        const stillReferenced = await client.query(
            `select cover_image_url as url from user_game_cover_overrides where cover_image_url = any($1::text[])
             union
             select icon_url as url from user_achievement_icon_overrides where icon_url = any($1::text[])`,
            [uploadedUrls]
        );
        const sharedUrls = new Set(stillReferenced.rows.map((row) => row.url as string));
        uploadedUrls = uploadedUrls.filter((url) => !sharedUrls.has(url));
        await client.query("commit");
    } catch (err) {
        await client.query("rollback");
        throw err;
    } finally {
        client.release();
    }

    try {
        await deleteUploadedFiles(uploadedUrls);
        return { fileCleanupPending: false };
    } catch (err) {
        // The database deletion is already committed and must not be rolled
        // back. Return 202 from the route so the user is not told the whole
        // deletion failed, while leaving a clear operator-visible error.
        console.error(`Account ${userId} deleted but one or more uploads need cleanup:`, err);
        return { fileCleanupPending: true };
    }
}
