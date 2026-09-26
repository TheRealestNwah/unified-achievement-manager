import { Router } from "express";
import { pool } from "../db";
import { requireAuth } from "../middleware/requireAuth";
import { getGamesForUser, getAchievementsForGame, getRecentActivity, getFunStats, getFullExportData } from "./queries";
import { recomputeUserScore } from "../scoring";
import {
    uploadCoverImage,
    uploadIconImage,
    publicUploadUrl,
    deleteIfUploaded,
    isAllowedImageType,
    saveImageBuffer,
    MAX_UPLOAD_BYTES,
} from "./uploads";
import { deleteUserAccount } from "../auth/accountDeletion";
import { getSteamGridDbApiKey } from "../settings/steamGridDbKey";
import {
    GRID_STYLES,
    GridFilters,
    SteamGridDbError,
    downloadGridImage,
    getGame,
    gridsForGame,
    gridsForSteamApp,
    isSteamGridDbImageUrl,
    searchGames,
} from "../steamgriddb/client";

export const gamesRouter = Router();

function destroyCurrentSession(req: import("express").Request): Promise<void> {
    return new Promise((resolve, reject) => {
        req.logout((logoutError) => {
            if (logoutError) return reject(logoutError);
            req.session.destroy((sessionError) => (sessionError ? reject(sessionError) : resolve()));
        });
    });
}

gamesRouter.delete("/account", requireAuth, async (req, res, next) => {
    try {
        if (req.body?.confirmation !== "DELETE") {
            return res.status(400).json({ error: 'Type "DELETE" to permanently delete your account.' });
        }

        const result = await deleteUserAccount(req.user!.id);
        await destroyCurrentSession(req);
        res.clearCookie("connect.sid");
        if (result.fileCleanupPending) {
            return res.status(202).json({ message: "Account deleted; uploaded-file cleanup is pending." });
        }
        res.status(204).end();
    } catch (err) {
        next(err);
    }
});

gamesRouter.get("/accounts", requireAuth, async (req, res, next) => {
    try {
        const result = await pool.query(
            "select platform_id, display_name, linked_at, last_synced_at from user_platform_accounts where user_id = $1 order by platform_id",
            [req.user!.id]
        );
        res.json(result.rows);
    } catch (err) {
        next(err);
    }
});

// Steam can't be disconnected here - it's the sign-in identity, not just a
// linked data source, so there's no account left to be signed in as
// afterward. Deleting the user_platform_accounts row cascades to that
// account's own user_owned_games/user_achievement_unlocks (see
// db/schema.sql's ON DELETE CASCADE) without touching the shared canonical
// games/achievements tables other users or platforms still reference.
gamesRouter.delete("/accounts/:platformId", requireAuth, async (req, res, next) => {
    try {
        const { platformId } = req.params;
        if (platformId === "steam") {
            return res.status(400).json({ error: "Steam can't be disconnected - it's how you sign in." });
        }

        const result = await pool.query(
            "delete from user_platform_accounts where user_id = $1 and platform_id = $2 returning id",
            [req.user!.id, platformId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: "No linked account for that platform" });
        }

        const score = await recomputeUserScore(req.user!.id);
        res.json({ score });
    } catch (err) {
        next(err);
    }
});

gamesRouter.get("/games", requireAuth, async (req, res, next) => {
    try {
        res.json(await getGamesForUser(req.user!.id));
    } catch (err) {
        next(err);
    }
});

// A cheap "has anything synced since I last looked" check the dashboard polls,
// so background syncs by the scheduler show up without a reload (see #248).
gamesRouter.get("/sync-status", requireAuth, async (req, res, next) => {
    try {
        res.setHeader("Cache-Control", "no-store");
        const result = await pool.query(
            "select max(last_synced_at) as last_synced_at from user_platform_accounts where user_id = $1",
            [req.user!.id]
        );
        res.json({ lastSyncedAt: result.rows[0]?.last_synced_at ?? null });
    } catch (err) {
        next(err);
    }
});

gamesRouter.get("/activity", requireAuth, async (req, res, next) => {
    try {
        const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit ?? "20"), 10) || 20, 1), 100);
        const offset = Math.max(Number.parseInt(String(req.query.offset ?? "0"), 10) || 0, 0);
        res.json(await getRecentActivity(req.user!.id, limit, offset));
    } catch (err) {
        next(err);
    }
});

gamesRouter.get("/stats", requireAuth, async (req, res, next) => {
    try {
        res.json(await getFunStats(req.user!.id));
    } catch (err) {
        next(err);
    }
});

function toCsv(rows: Record<string, unknown>[]): string {
    if (rows.length === 0) return "";
    const headers = Object.keys(rows[0]);
    const escape = (value: unknown) => {
        const str = value === null || value === undefined ? "" : String(value);
        return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    };
    return [headers.join(","), ...rows.map((row) => headers.map((h) => escape(row[h])).join(","))].join("\n");
}

// Scoped to the requesting user's own data only - req.user!.id, no way to
// pass a different user, no admin/global export (see #26).
gamesRouter.get("/export", requireAuth, async (req, res, next) => {
    try {
        const rows = await getFullExportData(req.user!.id);
        const wantsCsv =
            req.query.format === "csv" || (!req.query.format && (req.headers.accept ?? "").includes("text/csv"));

        if (wantsCsv) {
            res.setHeader("Content-Type", "text/csv");
            res.setHeader("Content-Disposition", 'attachment; filename="unified-achievement-manager-export.csv"');
            res.send(toCsv(rows));
        } else {
            res.setHeader("Content-Disposition", 'attachment; filename="unified-achievement-manager-export.json"');
            res.json(rows);
        }
    } catch (err) {
        next(err);
    }
});

gamesRouter.get("/games/:gameId/achievements", requireAuth, async (req, res, next) => {
    try {
        const achievements = await getAchievementsForGame(req.user!.id, req.params.gameId);
        if (!achievements) {
            return res.status(404).json({ error: "Game not found in your library" });
        }
        res.json(achievements);
    } catch (err) {
        next(err);
    }
});

// The platform entries a (possibly merged) game is made of, for the split
// control (see #169).
gamesRouter.get("/games/:gameId/platforms", requireAuth, async (req, res, next) => {
    try {
        if (!(await userOwnsGame(req.user!.id, req.params.gameId))) {
            return res.status(404).json({ error: "Game not found in your library" });
        }
        const result = await pool.query(
            `select id, platform_id, platform_title, console_variant from game_platform_links
             where game_id = $1 order by platform_id, console_variant nulls first`,
            [req.params.gameId]
        );
        res.json(result.rows);
    } catch (err) {
        next(err);
    }
});

const MAX_GAME_TITLE_LENGTH = 200;

// Sets the name a game shows: either one of its platform entries' own titles
// (see #170) or text the user typed (see #221). Sync never overwrites
// games.title for an existing game, so the choice sticks.
gamesRouter.put("/games/:gameId/title", requireAuth, async (req, res, next) => {
    try {
        const { gamePlatformLinkId, title } = req.body ?? {};
        if (typeof title === "string") {
            const trimmed = title.trim();
            if (!trimmed) return res.status(400).json({ error: "The name can't be empty" });
            if (trimmed.length > MAX_GAME_TITLE_LENGTH) {
                return res.status(400).json({ error: `The name can be at most ${MAX_GAME_TITLE_LENGTH} characters` });
            }
            if (!(await userOwnsGame(req.user!.id, req.params.gameId))) {
                return res.status(404).json({ error: "Game not found in your library" });
            }
            const result = await pool.query("update games set title = $2 where id = $1 returning title", [req.params.gameId, trimmed]);
            return res.json({ title: result.rows[0].title });
        }
        if (!gamePlatformLinkId || typeof gamePlatformLinkId !== "string") {
            return res.status(400).json({ error: "gamePlatformLinkId or title is required" });
        }
        if (!(await userOwnsGame(req.user!.id, req.params.gameId))) {
            return res.status(404).json({ error: "Game not found in your library" });
        }
        const result = await pool.query(
            `update games g set title = gpl.platform_title
             from game_platform_links gpl
             where g.id = $1 and gpl.id = $2 and gpl.game_id = g.id
             returning g.title`,
            [req.params.gameId, gamePlatformLinkId]
        );
        if (!result.rows[0]) {
            return res.status(400).json({ error: "That platform entry isn't part of this game" });
        }
        res.json({ title: result.rows[0].title });
    } catch (err) {
        next(err);
    }
});

// Renames a game to a SteamGridDB game's name, offered after picking that
// game's cover (see #214). The client sends the SteamGridDB game ID, not the
// name, so the title still comes from a known source rather than free text.
gamesRouter.put("/games/:gameId/title/steamgriddb", requireAuth, async (req, res, next) => {
    try {
        const sgdbGameId = Number(req.body?.sgdbGameId);
        if (!Number.isInteger(sgdbGameId) || sgdbGameId <= 0) {
            return res.status(400).json({ error: "sgdbGameId is required" });
        }
        const apiKey = await getSteamGridDbApiKey();
        if (!apiKey) return res.status(409).json({ error: "Add a SteamGridDB API key in settings first." });
        if (!(await userOwnsGame(req.user!.id, req.params.gameId))) {
            return res.status(404).json({ error: "Game not found in your library" });
        }
        const sgdbGame = await getGame(sgdbGameId, apiKey);
        const name = sgdbGame?.name.trim();
        if (!name) return res.status(404).json({ error: "SteamGridDB has no game with that ID" });
        const result = await pool.query("update games set title = $2 where id = $1 returning title", [req.params.gameId, name]);
        res.json({ title: result.rows[0].title });
    } catch (err) {
        if (err instanceof SteamGridDbError) return res.status(err.status === 401 || err.status === 403 ? 400 : 502).json({ error: err.message });
        next(err);
    }
});

// Hide a game from the library view, optionally also excluding its points
// from the user's score (see #192, user_game_visibility). "hidden" leaves
// the score untouched; "excluded" subtracts it, per recomputeUserScore.
gamesRouter.put("/games/:gameId/visibility", requireAuth, async (req, res, next) => {
    try {
        const { mode } = req.body ?? {};
        if (mode !== "hidden" && mode !== "excluded") {
            return res.status(400).json({ error: "mode must be 'hidden' or 'excluded'" });
        }
        if (!(await userOwnsGame(req.user!.id, req.params.gameId))) {
            return res.status(404).json({ error: "Game not found in your library" });
        }
        await pool.query(
            `insert into user_game_visibility (user_id, game_id, mode)
             values ($1, $2, $3)
             on conflict (user_id, game_id) do update set mode = excluded.mode`,
            [req.user!.id, req.params.gameId, mode]
        );
        const score = await recomputeUserScore(req.user!.id);
        res.json({ score });
    } catch (err) {
        next(err);
    }
});

// Un-hides/un-excludes a game (see #192).
gamesRouter.delete("/games/:gameId/visibility", requireAuth, async (req, res, next) => {
    try {
        if (!(await userOwnsGame(req.user!.id, req.params.gameId))) {
            return res.status(404).json({ error: "Game not found in your library" });
        }
        await pool.query("delete from user_game_visibility where user_id = $1 and game_id = $2", [
            req.user!.id,
            req.params.gameId,
        ]);
        const score = await recomputeUserScore(req.user!.id);
        res.json({ score });
    } catch (err) {
        next(err);
    }
});

// Games this user has hidden or excluded (see #192), for a "manage hidden
// games" list - otherwise a hidden game disappears from the dashboard with
// no way back short of re-syncing.
gamesRouter.get("/games/hidden", requireAuth, async (req, res, next) => {
    try {
        const result = await pool.query(
            `select g.id, g.title, ugv.mode
             from user_game_visibility ugv
             join games g on g.id = ugv.game_id
             where ugv.user_id = $1
             order by g.title`,
            [req.user!.id]
        );
        res.json(result.rows);
    } catch (err) {
        next(err);
    }
});

// One game's header data (title, cover, platforms, progress, visibility) for
// its own page, including hidden/excluded games the library list leaves out
// (see #237). Declared after /games/hidden so that path isn't read as an id.
gamesRouter.get("/games/:gameId", requireAuth, async (req, res, next) => {
    try {
        const [game] = await getGamesForUser(req.user!.id, { gameId: req.params.gameId });
        if (!game) return res.status(404).json({ error: "Game not found in your library" });
        res.json(game);
    } catch (err) {
        next(err);
    }
});

// Only checks that the URL is well-formed http(s) - deliberately doesn't
// fetch it server-side to validate content-type, which would let a pasted
// URL make the server issue requests to arbitrary (including internal)
// addresses. A bad/broken URL just fails to load client-side, same as any
// other image in this app (loading="lazy" + onerror removal).
function isHttpUrl(value: unknown): value is string {
    if (typeof value !== "string") return false;
    try {
        return ["http:", "https:"].includes(new URL(value).protocol);
    } catch {
        return false;
    }
}

// User-pasted cover art/icons (see #32) - scoped per-user (see
// db/schema.sql's user_game_cover_overrides/user_achievement_icon_overrides)
// since games/canonical_achievements are shared canonical rows across every
// user, not owned by any one of them.
async function userOwnsGame(userId: string, gameId: string): Promise<boolean> {
    const owns = await pool.query(
        `select 1 from user_owned_games uog
         join user_platform_accounts upa on upa.id = uog.user_platform_account_id
         where upa.user_id = $1 and uog.game_id = $2
         limit 1`,
        [userId, gameId]
    );
    return owns.rows.length > 0;
}

gamesRouter.put("/games/:gameId/cover", requireAuth, async (req, res, next) => {
    try {
        if (!isHttpUrl(req.body?.url)) {
            return res.status(400).json({ error: "url must be a valid http(s) URL" });
        }
        if (!(await userOwnsGame(req.user!.id, req.params.gameId))) {
            return res.status(404).json({ error: "Game not found in your library" });
        }

        // Read the old value before overwriting it - pasting a URL over a
        // previously uploaded file orphans that file on disk otherwise, the
        // same cleanup the dedicated DELETE/upload endpoints below do.
        const previous = await pool.query(
            "select cover_image_url from user_game_cover_overrides where user_id = $1 and game_id = $2",
            [req.user!.id, req.params.gameId]
        );
        await pool.query(
            `insert into user_game_cover_overrides (user_id, game_id, cover_image_url)
             values ($1, $2, $3)
             on conflict (user_id, game_id) do update set cover_image_url = excluded.cover_image_url`,
            [req.user!.id, req.params.gameId, req.body.url]
        );
        deleteIfUploaded(previous.rows[0]?.cover_image_url);
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

gamesRouter.post("/games/:gameId/cover/upload", requireAuth, (req, res, next) => {
    uploadCoverImage(req, res, async (err) => {
        try {
            if (err) return res.status(400).json({ error: err.message || "Upload failed" });
            if (!req.file) return res.status(400).json({ error: "file is required" });

            if (!(await userOwnsGame(req.user!.id, req.params.gameId))) {
                deleteIfUploaded(publicUploadUrl("covers", req.file));
                return res.status(404).json({ error: "Game not found in your library" });
            }

            const url = publicUploadUrl("covers", req.file);
            const previous = await pool.query(
                "select cover_image_url from user_game_cover_overrides where user_id = $1 and game_id = $2",
                [req.user!.id, req.params.gameId]
            );
            await pool.query(
                `insert into user_game_cover_overrides (user_id, game_id, cover_image_url)
                 values ($1, $2, $3)
                 on conflict (user_id, game_id) do update set cover_image_url = excluded.cover_image_url`,
                [req.user!.id, req.params.gameId, url]
            );
            deleteIfUploaded(previous.rows[0]?.cover_image_url);
            res.json({ ok: true, url });
        } catch (e) {
            next(e);
        }
    });
});

gamesRouter.delete("/games/:gameId/cover", requireAuth, async (req, res, next) => {
    try {
        const result = await pool.query(
            "delete from user_game_cover_overrides where user_id = $1 and game_id = $2 returning cover_image_url",
            [req.user!.id, req.params.gameId]
        );
        deleteIfUploaded(result.rows[0]?.cover_image_url);
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

function steamGridDbFilters(query: import("express").Request["query"]): GridFilters {
    const requested = typeof query.styles === "string" ? query.styles.split(",") : [];
    return {
        animated: query.animated === "true",
        styles: requested.filter((style) => (GRID_STYLES as readonly string[]).includes(style)),
    };
}

// Steam games are looked up by app ID (one call). Everything else - or a Steam
// game SteamGridDB has no portrait grids for - falls back to a title search,
// showing the first match's grids and returning the other matches so the user
// can switch to the right game.
gamesRouter.get("/games/:gameId/cover/steamgriddb/search", requireAuth, async (req, res, next) => {
    try {
        const apiKey = await getSteamGridDbApiKey();
        if (!apiKey) return res.status(409).json({ error: "Add a SteamGridDB API key in settings first." });
        const { gameId } = req.params;
        if (!(await userOwnsGame(req.user!.id, gameId))) {
            return res.status(404).json({ error: "Game not found in your library" });
        }

        const filters = steamGridDbFilters(req.query);
        const sgdbGameId = Number(req.query.sgdbGameId);
        if (Number.isInteger(sgdbGameId) && sgdbGameId > 0) {
            return res.json({ source: "game", matches: [], selectedGameId: sgdbGameId, grids: await gridsForGame(sgdbGameId, apiKey, filters) });
        }

        const term = typeof req.query.term === "string" ? req.query.term.trim().slice(0, 200) : "";
        if (!term) {
            const steam = await pool.query(
                "select platform_game_id from game_platform_links where game_id = $1 and platform_id = 'steam' order by platform_game_id limit 1",
                [gameId]
            );
            const appId = steam.rows[0]?.platform_game_id as string | undefined;
            if (appId) {
                const grids = await gridsForSteamApp(appId, apiKey, filters);
                if (grids.length) return res.json({ source: "steam", matches: [], selectedGameId: null, grids });
            }
        }

        const searchTerm = term || ((await pool.query("select title from games where id = $1", [gameId])).rows[0]?.title as string);
        const matches = (await searchGames(searchTerm, apiKey)).slice(0, 10);
        const selected = matches[0];
        res.json({
            source: "search",
            term: searchTerm,
            matches,
            selectedGameId: selected?.id ?? null,
            grids: selected ? await gridsForGame(selected.id, apiKey, filters) : [],
        });
    } catch (err) {
        if (err instanceof SteamGridDbError) return res.status(err.status === 401 || err.status === 403 ? 400 : 502).json({ error: err.message });
        next(err);
    }
});

gamesRouter.post("/games/:gameId/cover/steamgriddb/select", requireAuth, async (req, res, next) => {
    try {
        const url = req.body?.url;
        if (!isSteamGridDbImageUrl(url)) {
            return res.status(400).json({ error: "Only images from SteamGridDB can be picked here." });
        }
        if (!(await userOwnsGame(req.user!.id, req.params.gameId))) {
            return res.status(404).json({ error: "Game not found in your library" });
        }

        const { buffer, mimeType } = await downloadGridImage(url, MAX_UPLOAD_BYTES);
        if (!isAllowedImageType(mimeType)) {
            return res.status(400).json({ error: "That image isn't a JPEG, PNG, WebP, or GIF." });
        }
        const saved = await saveImageBuffer("covers", buffer, mimeType);

        const previous = await pool.query(
            "select cover_image_url from user_game_cover_overrides where user_id = $1 and game_id = $2",
            [req.user!.id, req.params.gameId]
        );
        await pool.query(
            `insert into user_game_cover_overrides (user_id, game_id, cover_image_url)
             values ($1, $2, $3)
             on conflict (user_id, game_id) do update set cover_image_url = excluded.cover_image_url`,
            [req.user!.id, req.params.gameId, saved]
        );
        deleteIfUploaded(previous.rows[0]?.cover_image_url);
        res.json({ ok: true, url: saved });
    } catch (err) {
        if (err instanceof SteamGridDbError) return res.status(err.status === 413 ? 400 : 502).json({ error: err.message });
        next(err);
    }
});

async function userOwnsAchievement(userId: string, achievementId: string): Promise<boolean> {
    const owns = await pool.query(
        `select 1 from canonical_achievements ca
         join user_owned_games uog on uog.game_id = ca.game_id
         join user_platform_accounts upa on upa.id = uog.user_platform_account_id
         where upa.user_id = $1 and ca.id = $2
         limit 1`,
        [userId, achievementId]
    );
    return owns.rows.length > 0;
}

gamesRouter.put("/achievements/:achievementId/icon", requireAuth, async (req, res, next) => {
    try {
        if (!isHttpUrl(req.body?.url)) {
            return res.status(400).json({ error: "url must be a valid http(s) URL" });
        }
        if (!(await userOwnsAchievement(req.user!.id, req.params.achievementId))) {
            return res.status(404).json({ error: "Achievement not found in your library" });
        }

        const previous = await pool.query(
            "select icon_url from user_achievement_icon_overrides where user_id = $1 and canonical_achievement_id = $2",
            [req.user!.id, req.params.achievementId]
        );
        await pool.query(
            `insert into user_achievement_icon_overrides (user_id, canonical_achievement_id, icon_url)
             values ($1, $2, $3)
             on conflict (user_id, canonical_achievement_id) do update set icon_url = excluded.icon_url`,
            [req.user!.id, req.params.achievementId, req.body.url]
        );
        deleteIfUploaded(previous.rows[0]?.icon_url);
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

gamesRouter.post("/achievements/:achievementId/icon/upload", requireAuth, (req, res, next) => {
    uploadIconImage(req, res, async (err) => {
        try {
            if (err) return res.status(400).json({ error: err.message || "Upload failed" });
            if (!req.file) return res.status(400).json({ error: "file is required" });

            if (!(await userOwnsAchievement(req.user!.id, req.params.achievementId))) {
                deleteIfUploaded(publicUploadUrl("icons", req.file));
                return res.status(404).json({ error: "Achievement not found in your library" });
            }

            const url = publicUploadUrl("icons", req.file);
            const previous = await pool.query(
                "select icon_url from user_achievement_icon_overrides where user_id = $1 and canonical_achievement_id = $2",
                [req.user!.id, req.params.achievementId]
            );
            await pool.query(
                `insert into user_achievement_icon_overrides (user_id, canonical_achievement_id, icon_url)
                 values ($1, $2, $3)
                 on conflict (user_id, canonical_achievement_id) do update set icon_url = excluded.icon_url`,
                [req.user!.id, req.params.achievementId, url]
            );
            deleteIfUploaded(previous.rows[0]?.icon_url);
            res.json({ ok: true, url });
        } catch (e) {
            next(e);
        }
    });
});

gamesRouter.delete("/achievements/:achievementId/icon", requireAuth, async (req, res, next) => {
    try {
        const result = await pool.query(
            "delete from user_achievement_icon_overrides where user_id = $1 and canonical_achievement_id = $2 returning icon_url",
            [req.user!.id, req.params.achievementId]
        );
        deleteIfUploaded(result.rows[0]?.icon_url);
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});
