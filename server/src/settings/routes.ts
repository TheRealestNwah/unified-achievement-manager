import { Router } from "express";
import { pool } from "../db";
import { getCsrfToken } from "../middleware/csrf";
import { requireAuth } from "../middleware/requireAuth";
import { hasSteamApiKey, isValidSteamApiKey, saveSteamApiKey } from "./steamApiKey";
import { getSteamGridDbApiKey, isValidSteamGridDbApiKey, removeSteamGridDbApiKey, saveSteamGridDbApiKey } from "./steamGridDbKey";
import { getDiscordPresenceEnabled, setDiscordPresenceEnabled } from "./discordPresence";
import { findDuplicateAcronym, getSearchAcronyms, saveSearchAcronyms, type SearchAcronym } from "./searchAcronyms";
import { getDesktopSettings, isDesktopApp, updateDesktopSettings } from "./desktopSettings";
import { getNewUnlocksSince } from "./newUnlocks";
import { isValidSyncInterval, setSyncIntervalMinutes, SYNC_INTERVAL_CHOICES } from "./syncInterval";
import { applySchedulerInterval, getSchedulerStatus } from "../scheduler";
import { createLocalProfile, MAX_DISPLAY_NAME_LENGTH, ProfileExistsError } from "../auth/localProfile";
import { APP_VERSION } from "../appVersion";

export const setupRouter = Router();
export const settingsRouter = Router();

settingsRouter.get("/discord-rich-presence", requireAuth, async (_req, res, next) => {
    try {
        res.json({ enabled: await getDiscordPresenceEnabled() });
    } catch (err) {
        next(err);
    }
});

settingsRouter.put("/discord-rich-presence", requireAuth, async (req, res, next) => {
    try {
        await setDiscordPresenceEnabled(Boolean(req.body?.enabled));
        res.status(204).end();
    } catch (err) {
        next(err);
    }
});

// Background sync interval (see #289). `available` is false only until the
// scheduler has started.
settingsRouter.get("/sync-interval", requireAuth, async (_req, res, next) => {
    try {
        const status = getSchedulerStatus();
        res.json({ available: status.enabled, minutes: status.intervalMinutes, choices: SYNC_INTERVAL_CHOICES });
    } catch (err) {
        next(err);
    }
});

settingsRouter.put("/sync-interval", requireAuth, async (req, res, next) => {
    try {
        const minutes = req.body?.minutes ?? null;
        if (!isValidSyncInterval(minutes)) {
            res.status(400).json({ error: `minutes must be one of ${SYNC_INTERVAL_CHOICES.map((c) => c ?? "null").join(", ")}` });
            return;
        }
        await setSyncIntervalMinutes(minutes);
        await applySchedulerInterval();
        const status = getSchedulerStatus();
        res.json({ minutes: status.intervalMinutes, nextRunAt: status.nextRunAt });
    } catch (err) {
        next(err);
    }
});

settingsRouter.get("/desktop", requireAuth, async (_req, res, next) => {
    try {
        res.json(await getDesktopSettings());
    } catch (err) {
        next(err);
    }
});

settingsRouter.put("/desktop", requireAuth, async (req, res, next) => {
    try {
        res.json(await updateDesktopSettings(req.body ?? {}));
    } catch (err) {
        next(err);
    }
});

// Backs the user-defined acronym list in Settings (see #194) - a normalized
// acronym/expansion pair merged client-side with the built-in list in
// public/search-text.js.
settingsRouter.get("/search-acronyms", requireAuth, async (_req, res, next) => {
    try {
        res.json(await getSearchAcronyms());
    } catch (err) {
        next(err);
    }
});

settingsRouter.put("/search-acronyms", requireAuth, async (req, res, next) => {
    try {
        const body = req.body;
        if (!Array.isArray(body)) {
            res.status(400).json({ error: "Expected an array of { acronym, expansion }." });
            return;
        }
        const acronyms: SearchAcronym[] = [];
        for (const entry of body) {
            const acronym = typeof entry?.acronym === "string" ? entry.acronym.trim() : "";
            const expansion = typeof entry?.expansion === "string" ? entry.expansion.trim() : "";
            if (!acronym || !expansion) {
                res.status(400).json({ error: "Each entry needs a non-empty acronym and expansion." });
                return;
            }
            acronyms.push({ acronym, expansion });
        }
        const duplicate = findDuplicateAcronym(acronyms);
        if (duplicate) {
            res.status(400).json({ error: `"${duplicate}" is already in your list - edit that entry instead.` });
            return;
        }
        await saveSearchAcronyms(acronyms);
        res.status(204).end();
    } catch (err) {
        next(err);
    }
});

settingsRouter.get("/steamgriddb-api-key", requireAuth, async (_req, res, next) => {
    try {
        res.json({ configured: Boolean(await getSteamGridDbApiKey()) });
    } catch (err) {
        next(err);
    }
});

settingsRouter.put("/steamgriddb-api-key", requireAuth, async (req, res, next) => {
    try {
        const apiKey = typeof req.body?.apiKey === "string" ? req.body.apiKey.trim() : "";
        if (!/^\S{1,200}$/.test(apiKey)) {
            res.status(400).json({ error: "Paste the API key from your SteamGridDB preferences." });
            return;
        }
        if (!(await isValidSteamGridDbApiKey(apiKey))) {
            res.status(400).json({ error: "SteamGridDB rejected that key. Check it at steamgriddb.com/profile/preferences/api." });
            return;
        }
        await saveSteamGridDbApiKey(apiKey);
        res.status(204).end();
    } catch (err) {
        next(err);
    }
});

settingsRouter.delete("/steamgriddb-api-key", requireAuth, async (_req, res, next) => {
    try {
        await removeSteamGridDbApiKey();
        res.status(204).end();
    } catch (err) {
        next(err);
    }
});

// Reachable before there's a profile, for the first-run screen. Once one
// exists, every request is signed in as it (see #393).
setupRouter.get("/status", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({
        profileExists: req.isAuthenticated(),
        steamApiKeyConfigured: hasSteamApiKey(),
        desktopApp: isDesktopApp(),
        version: APP_VERSION,
        csrfToken: getCsrfToken(req),
    });
});

// Unauthenticated and read-only for the same reason as discord-presence-data
// below: the Electron main process reads it to decide what closing the
// window does and whether to register with Windows startup (see #249).
setupRouter.get("/desktop-settings", async (_req, res, next) => {
    try {
        res.setHeader("Cache-Control", "no-store");
        res.json(await getDesktopSettings());
    } catch (err) {
        next(err);
    }
});

// Read by the Electron main process to notify about newly synced unlocks
// (see #250) - unauthenticated for the same reason as desktop-settings.
setupRouter.get("/new-unlocks", async (req, res, next) => {
    try {
        res.setHeader("Cache-Control", "no-store");
        const since = String(req.query.since ?? "");
        if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(since) || Number.isNaN(Date.parse(since))) {
            res.status(400).json({ error: "since must be an ISO timestamp" });
            return;
        }
        res.json(await getNewUnlocksSince(since));
    } catch (err) {
        next(err);
    }
});

// Unauthenticated like /status above - this is read by the Electron main
// process (desktop/src/discordPresence.ts, see #195), not the browser
// dashboard, and the main process has no session cookie of its own. Safe
// only because the server is bound to 127.0.0.1 (see server/src/config.ts) -
// this is a single-user local app, so "the" user's score is whoever's
// user_scores row was computed most recently.
setupRouter.get("/discord-presence-data", async (_req, res, next) => {
    try {
        res.setHeader("Cache-Control", "no-store");
        const enabled = await getDiscordPresenceEnabled();
        if (!enabled) {
            res.json({ enabled: false });
            return;
        }
        const result = await pool.query(
            `select u.username, s.level, s.total_points
             from user_scores s
             join users u on u.id = s.user_id
             order by s.computed_at desc
             limit 1`
        );
        const row = result.rows[0];
        res.json({
            enabled: true,
            username: row?.username ?? null,
            level: row ? Number(row.level) : null,
            totalPoints: row ? Number(row.total_points) : null,
        });
    } catch (err) {
        next(err);
    }
});

// First run (see #393): creates the local profile everything else belongs
// to, and signs this session in as it. Only while there's no profile yet.
setupRouter.post("/profile", async (req, res, next) => {
    try {
        const displayName = typeof req.body?.displayName === "string" ? req.body.displayName.trim() : "";
        if (!displayName || displayName.length > MAX_DISPLAY_NAME_LENGTH) {
            res.status(400).json({ error: `Pick a name up to ${MAX_DISPLAY_NAME_LENGTH} characters long.` });
            return;
        }
        const profile = await createLocalProfile(displayName);
        req.login(profile, (err) => (err ? next(err) : res.status(201).json(profile)));
    } catch (err) {
        if (err instanceof ProfileExistsError) {
            res.status(409).json({ error: "This app already has a profile." });
            return;
        }
        next(err);
    }
});

// The key is only needed to connect Steam (see #393), which the profile does.
setupRouter.put("/steam-api-key", requireAuth, async (req, res, next) => {
    try {
        const apiKey = typeof req.body?.apiKey === "string" ? req.body.apiKey.trim() : "";
        if (!/^[A-Fa-f0-9]{32}$/.test(apiKey)) {
            res.status(400).json({ error: "A Steam Web API key is 32 hexadecimal characters." });
            return;
        }
        if (!(await isValidSteamApiKey(apiKey))) {
            res.status(400).json({ error: "Steam rejected that key. Check it at steamcommunity.com/dev/apikey." });
            return;
        }

        await saveSteamApiKey(apiKey);
        res.status(204).end();
    } catch (err) {
        next(err);
    }
});
