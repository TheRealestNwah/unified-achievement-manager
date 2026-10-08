import path from "path";
import { Router } from "express";
import { pool } from "../db";
import { requireAuth } from "../middleware/requireAuth";
import { runAccountSync, PlatformAccountRow } from "../sync/runAccountSync";
import { sendSyncFailure } from "../sync/syncFailureResponse";
import { runMatchingAndGetScore } from "../matching";
import { assertSameAccountOnReconnect, clearSyncError, DifferentAccountError } from "../sync/reconnect";
import { listUsers, Rpcs3FolderError, trophyDir } from "./folder";
import { COMMUNICATION_ID } from "./trophyFiles";

// RPCS3 (see #522) is a folder on this computer rather than an online
// account: connecting saves the RPCS3 folder and which of its users to read.
export const rpcs3Router = Router();

async function getRpcs3Account(userId: string) {
    const result = await pool.query(
        "select id, user_id, platform_id, platform_account_id, access_token, refresh_token, local_folder from user_platform_accounts where user_id = $1 and platform_id = 'rpcs3'",
        [userId]
    );
    return result.rows[0] as (PlatformAccountRow & { local_folder: string | null }) | undefined;
}

function folderFrom(body: unknown): string {
    const folder = (body as { folder?: unknown } | undefined)?.folder;
    if (typeof folder !== "string") throw new Rpcs3FolderError("folder is required");
    return path.resolve(folder.trim());
}

// The RPCS3 users in a folder, to pick from before connecting.
rpcs3Router.post("/users", requireAuth, (req, res, next) => {
    try {
        res.json({ users: listUsers(folderFrom(req.body)) });
    } catch (err) {
        if (err instanceof Rpcs3FolderError) return res.status(400).json({ error: err.message });
        next(err);
    }
});

rpcs3Router.post("/connect", requireAuth, async (req, res, next) => {
    try {
        const folder = folderFrom(req.body);
        const rpcs3User = listUsers(folder).find((u) => u.id === req.body?.userId);
        if (!rpcs3User) return res.status(400).json({ error: "Pick one of the RPCS3 users in that folder." });

        // Pointing at a moved RPCS3 folder keeps the account; a different
        // RPCS3 user is a different set of trophies.
        await assertSameAccountOnReconnect(req.user!.id, "rpcs3", rpcs3User.id, "RPCS3 user");

        await pool.query(
            `insert into user_platform_accounts (user_id, platform_id, platform_account_id, display_name, local_folder)
             values ($1, 'rpcs3', $2, $3, $4)
             on conflict (user_id, platform_id) do update
                set display_name = excluded.display_name,
                    local_folder = excluded.local_folder`,
            [req.user!.id, rpcs3User.id, rpcs3User.name, folder]
        );
        await clearSyncError(req.user!.id, "rpcs3");

        res.json({ username: rpcs3User.name });
    } catch (err) {
        if (err instanceof Rpcs3FolderError) return res.status(400).json({ error: err.message });
        if (err instanceof DifferentAccountError) return res.status(409).json({ error: err.message });
        next(err);
    }
});

rpcs3Router.post("/sync", requireAuth, async (req, res, next) => {
    try {
        const account = await getRpcs3Account(req.user!.id);
        if (!account) return res.status(404).json({ error: "RPCS3 isn't connected" });

        const summary = await runAccountSync(account);
        const score = await runMatchingAndGetScore(req.user!.id);
        res.json({ ...summary, score });
    } catch (err) {
        sendSyncFailure("rpcs3", err, res, next);
    }
});

// Trophy and game icons, straight from the RPCS3 folder. Mounted outside
// /api (see index.ts) so a game page's worth of icons doesn't count against
// the API rate limit. Only these file names, in a communication-ID folder of
// the connected user, can be read.
const ICON_FILE = /^(ICON0|TROP\d{3})\.PNG$/;

export const rpcs3IconsRouter = Router();

rpcs3IconsRouter.get("/:communicationId/:file", requireAuth, async (req, res, next) => {
    try {
        const { communicationId, file } = req.params;
        if (!COMMUNICATION_ID.test(communicationId) || !ICON_FILE.test(file)) return res.status(404).end();
        const account = await getRpcs3Account(req.user!.id);
        if (!account?.local_folder) return res.status(404).end();
        const iconPath = path.join(trophyDir(account.local_folder, account.platform_account_id), communicationId, file);
        res.sendFile(iconPath, { maxAge: "1d", dotfiles: "deny" }, (err) => {
            if (err && !res.headersSent) res.status(404).end();
        });
    } catch (err) {
        if (err instanceof Rpcs3FolderError) return res.status(404).end();
        next(err);
    }
});
