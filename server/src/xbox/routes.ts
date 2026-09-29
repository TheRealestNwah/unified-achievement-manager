import { Router } from "express";
import { pool } from "../db";
import { requireAuth } from "../middleware/requireAuth";
import { getAccount, XboxApiError } from "./client";
import { runAccountSync, PlatformAccountRow } from "../sync/runAccountSync";
import { sendSyncFailure } from "../sync/syncFailureResponse";
import { runMatchingAndGetScore } from "../matching";
import { config } from "../config";
import { encryptCredential } from "../security/credentials";
import { assertSameAccountOnReconnect, clearSyncError, DifferentAccountError } from "../sync/reconnect";

export const xboxRouter = Router();

async function getXboxAccount(userId: string) {
    const result = await pool.query(
        "select id, user_id, platform_id, platform_account_id, access_token, refresh_token from user_platform_accounts where user_id = $1 and platform_id = 'xbox'",
        [userId]
    );
    return result.rows[0] as PlatformAccountRow | undefined;
}

// No OAuth flow for Xbox - the user pastes a personal OpenXBL API key
// (generated at xbl.io/dashboard), which we validate and store as this
// linked account's access_token.
xboxRouter.post("/connect", requireAuth, async (req, res, next) => {
    try {
        const apiKey = req.body?.apiKey;
        if (!apiKey || typeof apiKey !== "string") {
            return res.status(400).json({ error: "apiKey is required" });
        }

        const account = await getAccount(apiKey);

        await assertSameAccountOnReconnect(req.user!.id, "xbox", account.xuid, "Xbox");

        await pool.query(
            `insert into user_platform_accounts (user_id, platform_id, platform_account_id, display_name, access_token)
             values ($1, 'xbox', $2, $3, $4)
             on conflict (user_id, platform_id) do update
                set platform_account_id = excluded.platform_account_id,
                    display_name = excluded.display_name,
                    access_token = excluded.access_token`,
            [req.user!.id, account.xuid, account.gamertag, encryptCredential(apiKey, config.credentialEncryptionKey)]
        );

        await clearSyncError(req.user!.id, "xbox");

        res.json({ gamertag: account.gamertag, gamerscore: account.gamerscore });
    } catch (err) {
        if (err instanceof DifferentAccountError) return res.status(409).json({ error: err.message });
        if (err instanceof XboxApiError && err.status === 401) {
            return res.status(400).json({ error: "That API key was rejected by OpenXBL - check it and try again." });
        }
        next(err);
    }
});

xboxRouter.post("/sync", requireAuth, async (req, res, next) => {
    try {
        const account = await getXboxAccount(req.user!.id);
        if (!account) {
            return res.status(404).json({ error: "No linked Xbox account" });
        }
        const summary = await runAccountSync(account);
        const score = await runMatchingAndGetScore(req.user!.id);
        res.json({ ...summary, score });
    } catch (err) {
        sendSyncFailure("xbox", err, res, next);
    }
});
