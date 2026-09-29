import { Router } from "express";
import { pool } from "../db";
import { requireAuth } from "../middleware/requireAuth";
import { GOG_LOGIN_URL, exchangeCodeForTokens, getUsername, GogApiError } from "./client";
import { runAccountSync, PlatformAccountRow } from "../sync/runAccountSync";
import { sendSyncFailure } from "../sync/syncFailureResponse";
import { runMatchingAndGetScore } from "../matching";
import { config } from "../config";
import { encryptCredential } from "../security/credentials";
import { assertSameAccountOnReconnect, clearSyncError, DifferentAccountError } from "../sync/reconnect";

export const gogRouter = Router();

async function getGogAccount(userId: string) {
    const result = await pool.query(
        "select id, user_id, platform_id, platform_account_id, access_token, refresh_token from user_platform_accounts where user_id = $1 and platform_id = 'gog'",
        [userId]
    );
    return result.rows[0] as PlatformAccountRow | undefined;
}

// No embeddable OAuth redirect here - GOG's documented redirect_uri lands on
// a page on GOG's own domain, not one this app controls (see client.ts). The
// user visits GOG_LOGIN_URL themselves, logs in, and pastes the "code" query
// param off the resulting URL - the same paste-a-value pattern PSN's NPSSO
// flow already uses.
gogRouter.get("/login-url", requireAuth, (_req, res) => {
    res.json({ url: GOG_LOGIN_URL });
});

gogRouter.post("/connect", requireAuth, async (req, res, next) => {
    try {
        const code = req.body?.code;
        if (!code || typeof code !== "string") {
            return res.status(400).json({ error: "code is required" });
        }

        const tokens = await exchangeCodeForTokens(code);
        const username = await getUsername(tokens.userId);

        await assertSameAccountOnReconnect(req.user!.id, "gog", tokens.userId, "GOG");

        await pool.query(
            `insert into user_platform_accounts (user_id, platform_id, platform_account_id, display_name, access_token, refresh_token)
             values ($1, 'gog', $2, $3, $4, $5)
             on conflict (user_id, platform_id) do update
                set platform_account_id = excluded.platform_account_id,
                    display_name = excluded.display_name,
                    access_token = excluded.access_token,
                    refresh_token = excluded.refresh_token`,
            [req.user!.id, tokens.userId, username, encryptCredential(tokens.accessToken, config.credentialEncryptionKey), encryptCredential(tokens.refreshToken, config.credentialEncryptionKey)]
        );

        await clearSyncError(req.user!.id, "gog");

        res.json({ username });
    } catch (err) {
        if (err instanceof DifferentAccountError) return res.status(409).json({ error: err.message });
        if (err instanceof GogApiError && err.status === 401) {
            return res.status(400).json({ error: err.message });
        }
        next(err);
    }
});

gogRouter.post("/sync", requireAuth, async (req, res, next) => {
    try {
        const account = await getGogAccount(req.user!.id);
        if (!account) {
            return res.status(404).json({ error: "No linked GOG account" });
        }

        // Same refresh-then-sync dance as PSN - GOG access tokens last
        // roughly an hour, so every sync refreshes unconditionally.
        const summary = await runAccountSync(account);
        const score = await runMatchingAndGetScore(req.user!.id);
        res.json({ ...summary, score });
    } catch (err) {
        sendSyncFailure("gog", err, res, next);
    }
});
