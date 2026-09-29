import { Router } from "express";
import { pool } from "../db";
import { requireAuth } from "../middleware/requireAuth";
import { runAccountSync, PlatformAccountRow } from "../sync/runAccountSync";
import { sendSyncFailure } from "../sync/syncFailureResponse";
import { runMatchingAndGetScore } from "../matching";

export const steamRouter = Router();

steamRouter.post("/sync", requireAuth, async (req, res, next) => {
    try {
        const account = await pool.query(
            "select id, user_id, platform_id, platform_account_id, access_token, refresh_token from user_platform_accounts where user_id = $1 and platform_id = 'steam'",
            [req.user!.id]
        );
        if (!account.rows[0]) {
            return res.status(404).json({ error: "No linked Steam account" });
        }
        const summary = await runAccountSync(account.rows[0] as PlatformAccountRow);
        const score = await runMatchingAndGetScore(req.user!.id);
        res.json({ ...summary, score });
    } catch (err) {
        sendSyncFailure("steam", err, res, next);
    }
});
