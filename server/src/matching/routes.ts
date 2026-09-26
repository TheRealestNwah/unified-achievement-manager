import { Router } from "express";
import { pool } from "../db";
import { requireAuth } from "../middleware/requireAuth";
import { runMatching } from "./index";
import { confirmMatchCandidate, rejectMatchCandidate, matchAchievementsForGame } from "./achievementMatcher";
import { mergeGames, confirmGameMergeCandidate, rejectGameMergeCandidate } from "./gameMatcher";
import { splitPlatformLink, GameSplitError } from "./gameSplitter";
import { confirmGameSplitCandidate, rejectGameSplitCandidate } from "./legacySignalSplitDetector";
import { recomputeUserScore } from "../scoring";
import { normalizeRarityTiersForAllGames, normalizeRarityTiersForGame } from "../scoring/rarityNormalization";

export const matchingRouter = Router();

// Any signed-in user can trigger this for now - it's a global job with no
// per-user side effects beyond recomputing scores. A real deployment would
// run this on a schedule instead of on demand.
matchingRouter.post("/run", requireAuth, async (_req, res, next) => {
    try {
        res.json(await runMatching());
    } catch (err) {
        next(err);
    }
});

// Manual game merge: automatic matching (runMatching, above) only merges on
// exact normalized title, which deliberately misses genuine same-game cases
// with differently formatted titles across platforms (e.g. "Skyrim" on PSN
// vs "The Elder Scrolls V: Skyrim" on Steam - a fuzzy title match risks
// merging genuinely different games, so this needs a human to confirm it).
matchingRouter.post("/games/merge", requireAuth, async (req, res, next) => {
    try {
        const { keepGameId, mergeGameId } = req.body ?? {};
        if (!keepGameId || !mergeGameId || typeof keepGameId !== "string" || typeof mergeGameId !== "string") {
            return res.status(400).json({ error: "keepGameId and mergeGameId are required" });
        }
        if (keepGameId === mergeGameId) {
            return res.status(400).json({ error: "Can't merge a game with itself" });
        }

        // Scoped to games this user actually owns - canonical tables are
        // shared across every user of the app, so without this a user could
        // merge two games from the global catalog they've never even synced.
        const owned = await pool.query(
            `select game_id from user_owned_games uog
             join user_platform_accounts upa on upa.id = uog.user_platform_account_id
             where upa.user_id = $1 and uog.game_id in ($2, $3)`,
            [req.user!.id, keepGameId, mergeGameId]
        );
        if (owned.rows.length < 2) {
            return res.status(404).json({ error: "One or both games aren't in your library" });
        }

        await mergeGames(keepGameId, mergeGameId);

        // Scoped to just this game rather than the full runMatching() pass -
        // a merge only changes this one game's achievement set, so re-running
        // matching/rarity-tiering for the whole library (hundreds of
        // unrelated games) would make an interactive "click to merge" action
        // take many seconds for no benefit.
        const achievementResult = await matchAchievementsForGame(keepGameId);
        await normalizeRarityTiersForGame(keepGameId);

        // Still rescore every user who owns this (shared, canonical) game,
        // not just whoever clicked - the same reasoning as the candidate
        // confirm/reject handlers below.
        const affectedUsers = await pool.query(
            `select distinct upa.user_id from user_owned_games uog
             join user_platform_accounts upa on upa.id = uog.user_platform_account_id
             where uog.game_id = $1`,
            [keepGameId]
        );
        for (const user of affectedUsers.rows) await recomputeUserScore(user.user_id);

        res.json({ ...achievementResult, usersRescored: affectedUsers.rows.length });
    } catch (err) {
        next(err);
    }
});

// Undo for the merge above, one platform entry at a time (see #169).
matchingRouter.post("/games/:gameId/split", requireAuth, async (req, res, next) => {
    try {
        const { gamePlatformLinkId } = req.body ?? {};
        if (!gamePlatformLinkId || typeof gamePlatformLinkId !== "string") {
            return res.status(400).json({ error: "gamePlatformLinkId is required" });
        }
        const { gameId } = req.params;

        const owned = await pool.query(
            `select 1 from user_owned_games uog
             join user_platform_accounts upa on upa.id = uog.user_platform_account_id
             where upa.user_id = $1 and uog.game_id = $2
             limit 1`,
            [req.user!.id, gameId]
        );
        if (owned.rows.length === 0) {
            return res.status(404).json({ error: "Game not found in your library" });
        }

        let result;
        try {
            result = await splitPlatformLink(gameId, gamePlatformLinkId);
        } catch (err) {
            if (err instanceof GameSplitError) return res.status(400).json({ error: err.message });
            throw err;
        }

        // Splitting only takes achievements apart, so there's nothing new to
        // match - but both halves have a different set to tier rarity over.
        await normalizeRarityTiersForGame(gameId);
        await normalizeRarityTiersForGame(result.newGameId);

        const affectedUsers = await pool.query(
            `select distinct upa.user_id from user_owned_games uog
             join user_platform_accounts upa on upa.id = uog.user_platform_account_id
             where uog.game_id in ($1, $2)`,
            [gameId, result.newGameId]
        );
        for (const user of affectedUsers.rows) await recomputeUserScore(user.user_id);

        res.json({ ...result, usersRescored: affectedUsers.rows.length });
    } catch (err) {
        next(err);
    }
});

matchingRouter.get("/candidates", requireAuth, async (_req, res, next) => {
    try {
        const result = await pool.query(`
            select
                amc.id,
                amc.confidence,
                g.title as game_title,
                apl.platform_id as candidate_platform,
                apl.platform_name as candidate_name,
                target.name as target_name,
                target.tier as target_tier,
                target.tier_source as target_tier_source,
                (select array_agg(distinct platform_id) from achievement_platform_links where canonical_achievement_id = target.id) as target_platforms
            from achievement_match_candidates amc
            join achievement_platform_links apl on apl.id = amc.achievement_platform_link_id
            join canonical_achievements source_ca on source_ca.id = apl.canonical_achievement_id
            join games g on g.id = source_ca.game_id
            join canonical_achievements target on target.id = amc.candidate_canonical_achievement_id
            where amc.status = 'pending'
            order by amc.confidence desc
        `);
        res.json(result.rows);
    } catch (err) {
        next(err);
    }
});

matchingRouter.post("/candidates/:id/confirm", requireAuth, async (req, res, next) => {
    try {
        await confirmMatchCandidate(req.params.id);
        // Global data changed - the same recompute-everyone pass runMatching
        // does, since a merge can affect users other than whoever clicked.
        await normalizeRarityTiersForAllGames();
        const users = await pool.query("select id from users");
        for (const user of users.rows) await recomputeUserScore(user.id);
        res.status(204).end();
    } catch (err) {
        next(err);
    }
});

matchingRouter.post("/candidates/:id/reject", requireAuth, async (req, res, next) => {
    try {
        await rejectMatchCandidate(req.params.id);
        res.status(204).end();
    } catch (err) {
        next(err);
    }
});

// Whole-game merge suggestions left by matchGames (see #73, #76) - same
// shape of review queue as achievement candidates above, one level up.
matchingRouter.get("/game-candidates", requireAuth, async (_req, res, next) => {
    try {
        const result = await pool.query(`
            select
                gmc.id,
                gmc.confidence,
                gmc.reason,
                a.title as game_a_title,
                -- Includes console_variant (e.g. "psn (PS4)"), not just the bare
                -- platform_id, so an exact-title-platform-collision candidate
                -- (see #196) - where both sides are on the same platform but
                -- different consoles - doesn't show two identical badges.
                (select array_agg(distinct platform_id || coalesce(' (' || console_variant || ')', ''))
                 from game_platform_links where game_id = a.id) as game_a_platforms,
                b.title as game_b_title,
                (select array_agg(distinct platform_id || coalesce(' (' || console_variant || ')', ''))
                 from game_platform_links where game_id = b.id) as game_b_platforms
            from game_merge_candidates gmc
            join games a on a.id = gmc.game_a_id
            join games b on b.id = gmc.game_b_id
            where gmc.status = 'pending'
            order by gmc.confidence desc
        `);
        res.json(result.rows);
    } catch (err) {
        next(err);
    }
});

matchingRouter.post("/game-candidates/:id/confirm", requireAuth, async (req, res, next) => {
    try {
        const candidate = await pool.query("select game_a_id from game_merge_candidates where id = $1", [req.params.id]);
        if (!candidate.rows[0]) return res.status(404).json({ error: "Game merge candidate not found" });
        const keepGameId = candidate.rows[0].game_a_id;

        await confirmGameMergeCandidate(req.params.id);

        // Same follow-up as the manual game-merge route above: the merge
        // only changes this one game's achievement set, so re-run matching
        // and rarity-tiering scoped to it rather than the whole library.
        await matchAchievementsForGame(keepGameId);
        await normalizeRarityTiersForGame(keepGameId);

        const affectedUsers = await pool.query(
            `select distinct upa.user_id from user_owned_games uog
             join user_platform_accounts upa on upa.id = uog.user_platform_account_id
             where uog.game_id = $1`,
            [keepGameId]
        );
        for (const user of affectedUsers.rows) await recomputeUserScore(user.user_id);

        res.status(204).end();
    } catch (err) {
        next(err);
    }
});

matchingRouter.post("/game-candidates/:id/reject", requireAuth, async (req, res, next) => {
    try {
        await rejectGameMergeCandidate(req.params.id);
        res.status(204).end();
    } catch (err) {
        next(err);
    }
});

// Games already combining a legacy-signal platform link (RetroAchievements,
// or a legacy-only PSN/Xbox release) with a non-legacy one - almost always a
// merge from before matchGames refused to create that shape (see #230).
// "Confirm" here means "yes, split it" (reusing splitPlatformLink, the same
// undo path "Link games" exposes manually); "reject" means a human looked
// and decided this really is the same release, so stop suggesting it.
matchingRouter.get("/game-split-candidates", requireAuth, async (_req, res, next) => {
    try {
        const result = await pool.query(`
            select
                gsc.id,
                gsc.reason,
                g.title as game_title,
                gpl.platform_id as candidate_platform,
                gpl.console_variant as candidate_console_variant,
                gpl.platform_title as candidate_platform_title,
                (select array_agg(distinct platform_id || coalesce(' (' || console_variant || ')', ''))
                 from game_platform_links where game_id = g.id and id != gsc.game_platform_link_id) as other_platforms
            from game_split_candidates gsc
            join games g on g.id = gsc.game_id
            join game_platform_links gpl on gpl.id = gsc.game_platform_link_id
            where gsc.status = 'pending'
            order by g.title
        `);
        res.json(result.rows);
    } catch (err) {
        next(err);
    }
});

matchingRouter.post("/game-split-candidates/:id/confirm", requireAuth, async (req, res, next) => {
    try {
        const candidate = await pool.query("select game_id from game_split_candidates where id = $1", [req.params.id]);
        if (!candidate.rows[0]) return res.status(404).json({ error: "Game split candidate not found" });
        const sourceGameId = candidate.rows[0].game_id;

        let result;
        try {
            result = await confirmGameSplitCandidate(req.params.id);
        } catch (err) {
            if (err instanceof GameSplitError) return res.status(400).json({ error: err.message });
            throw err;
        }

        await normalizeRarityTiersForGame(sourceGameId);
        await normalizeRarityTiersForGame(result.newGameId);

        const affectedUsers = await pool.query(
            `select distinct upa.user_id from user_owned_games uog
             join user_platform_accounts upa on upa.id = uog.user_platform_account_id
             where uog.game_id in ($1, $2)`,
            [sourceGameId, result.newGameId]
        );
        for (const user of affectedUsers.rows) await recomputeUserScore(user.user_id);

        res.json({ ...result, usersRescored: affectedUsers.rows.length });
    } catch (err) {
        next(err);
    }
});

matchingRouter.post("/game-split-candidates/:id/reject", requireAuth, async (req, res, next) => {
    try {
        await rejectGameSplitCandidate(req.params.id);
        res.status(204).end();
    } catch (err) {
        next(err);
    }
});
