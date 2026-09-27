import { Router } from "express";
import { pool } from "../db";
import { requireAuth } from "../middleware/requireAuth";
import { exchangeNpssoForAccessCode, exchangeAccessCodeForTokens, decodeIdToken, PsnApiError } from "./client";
import { runAccountSync, PlatformAccountRow } from "../sync/runAccountSync";
import { runMatchingAndGetScore } from "../matching";
import { config } from "../config";
import { encryptCredential } from "../security/credentials";
import { assertSameAccountOnReconnect, clearSyncError, DifferentAccountError } from "../sync/reconnect";

export const psnRouter = Router();

async function getPsnAccount(userId: string) {
    const result = await pool.query(
        "select id, user_id, platform_id, platform_account_id, access_token, refresh_token from user_platform_accounts where user_id = $1 and platform_id = 'psn'",
        [userId]
    );
    return result.rows[0] as PlatformAccountRow | undefined;
}

// No OAuth redirect flow here - the user pastes an NPSSO token, retrieved by
// visiting https://ca.account.sony.com/api/v1/ssocookie while logged into
// playstation.com in their own browser. We exchange it for real OAuth tokens
// server-side and never see their PSN password.
psnRouter.post("/connect", requireAuth, async (req, res, next) => {
    try {
        const npsso = req.body?.npsso;
        if (!npsso || typeof npsso !== "string") {
            return res.status(400).json({ error: "npsso is required" });
        }

        const accessCode = await exchangeNpssoForAccessCode(npsso);
        const tokens = await exchangeAccessCodeForTokens(accessCode);
        const { onlineId, accountId } = decodeIdToken(tokens.idToken);

        await assertSameAccountOnReconnect(req.user!.id, "psn", accountId, "PSN");

        await pool.query(
            `insert into user_platform_accounts (user_id, platform_id, platform_account_id, display_name, access_token, refresh_token)
             values ($1, 'psn', $2, $3, $4, $5)
             on conflict (user_id, platform_id) do update
                set platform_account_id = excluded.platform_account_id,
                    display_name = excluded.display_name,
                    access_token = excluded.access_token,
                    refresh_token = excluded.refresh_token`,
            [req.user!.id, accountId, onlineId, encryptCredential(tokens.accessToken, config.credentialEncryptionKey), encryptCredential(tokens.refreshToken, config.credentialEncryptionKey)]
        );

        await clearSyncError(req.user!.id, "psn");

        res.json({ onlineId });
    } catch (err) {
        if (err instanceof DifferentAccountError) return res.status(409).json({ error: err.message });
        if (err instanceof PsnApiError && err.status === 401) {
            return res.status(400).json({ error: err.message });
        }
        next(err);
    }
});

psnRouter.post("/sync", requireAuth, async (req, res, next) => {
    try {
        const account = await getPsnAccount(req.user!.id);
        if (!account) {
            return res.status(404).json({ error: "No linked PlayStation account" });
        }

        // runAccountSync refreshes the access token first - PSN's last
        // roughly an hour, so every sync refreshes unconditionally rather
        // than tracking expiry ourselves.
        const summary = await runAccountSync(account);
        const score = await runMatchingAndGetScore(req.user!.id);
        res.json({ ...summary, score });
    } catch (err) {
        if (err instanceof PsnApiError && err.status === 401) {
            return res.status(400).json({ error: "Your PlayStation session expired - reconnect with a fresh NPSSO token." });
        }
        next(err);
    }
});
