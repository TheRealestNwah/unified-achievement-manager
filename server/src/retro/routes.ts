import { Router } from "express";
import { pool } from "../db";
import { requireAuth } from "../middleware/requireAuth";
import { verifyAccount, RetroApiError } from "./client";
import { runAccountSync, PlatformAccountRow } from "../sync/runAccountSync";
import { runMatchingAndGetScore } from "../matching";
import { config } from "../config";
import { encryptCredential } from "../security/credentials";
import { assertSameAccountOnReconnect, clearSyncError, DifferentAccountError } from "../sync/reconnect";

export const retroRouter = Router();

async function getRetroAccount(userId: string) {
    const result = await pool.query(
        "select id, user_id, platform_id, platform_account_id, access_token, refresh_token from user_platform_accounts where user_id = $1 and platform_id = 'retroachievements'",
        [userId]
    );
    return result.rows[0] as PlatformAccountRow | undefined;
}

// No OAuth flow - the user pastes their RA username plus a personal Web API
// key (generated at retroachievements.org/settings), the same personal-key
// pattern as Xbox/OpenXBL since RA has no OAuth either.
retroRouter.post("/connect", requireAuth, async (req, res, next) => {
    try {
        const username = req.body?.username;
        const apiKey = req.body?.apiKey;
        if (!username || typeof username !== "string" || !apiKey || typeof apiKey !== "string") {
            return res.status(400).json({ error: "username and apiKey are required" });
        }

        const account = await verifyAccount(username, apiKey);

        await assertSameAccountOnReconnect(req.user!.id, "retroachievements", account.username, "RetroAchievements");

        await pool.query(
            `insert into user_platform_accounts (user_id, platform_id, platform_account_id, display_name, access_token)
             values ($1, 'retroachievements', $2, $3, $4)
             on conflict (user_id, platform_id) do update
                set platform_account_id = excluded.platform_account_id,
                    display_name = excluded.display_name,
                    access_token = excluded.access_token`,
            [req.user!.id, account.username, account.username, encryptCredential(apiKey, config.credentialEncryptionKey)]
        );

        await clearSyncError(req.user!.id, "retroachievements");

        res.json({ username: account.username });
    } catch (err) {
        if (err instanceof DifferentAccountError) return res.status(409).json({ error: err.message });
        if (err instanceof RetroApiError && (err.status === 401 || err.status === 404)) {
            return res.status(400).json({ error: err.message });
        }
        next(err);
    }
});

retroRouter.post("/sync", requireAuth, async (req, res, next) => {
    try {
        const account = await getRetroAccount(req.user!.id);
        if (!account) {
            return res.status(404).json({ error: "No linked RetroAchievements account" });
        }
        const summary = await runAccountSync(account);
        const score = await runMatchingAndGetScore(req.user!.id);
        res.json({ ...summary, score });
    } catch (err) {
        if (err instanceof RetroApiError && err.status === 401) {
            return res.status(400).json({ error: "Your RetroAchievements API key was rejected - reconnect your account." });
        }
        next(err);
    }
});
