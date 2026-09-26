import { pool } from "../db";
import { matchGames } from "./gameMatcher";
import { detectLegacySignalSplitCandidates } from "./legacySignalSplitDetector";
import { matchAchievementsForAllGames } from "./achievementMatcher";
import { enrichGamesWithSteamCatalog } from "./steamCatalogEnrichment";
import { enrichGamesWithXboxCatalog } from "./xboxCatalogEnrichment";
import { enrichGamesWithRetroCatalog } from "./retroCatalogEnrichment";
import { recomputeUserScore, getUserScore, UserScore } from "../scoring";
import { normalizeRarityTiersForAllGames } from "../scoring/rarityNormalization";

export interface MatchingSummary {
    gameGroupsMerged: number;
    gamesRemoved: number;
    gameCandidatesRecorded: number;
    steamCatalogGamesEnriched: number;
    xboxCatalogGamesEnriched: number;
    retroCatalogGamesEnriched: number;
    achievementsMerged: number;
    achievementCandidatesRecorded: number;
    gameSplitCandidatesRecorded: number;
    usersRescored: number;
}

// Global maintenance job, not a per-user action: operates on the shared
// canonical tables, so it runs across every user's data at once. Merging
// achievements changes how many distinct canonical achievements exist, so
// every user's cached score is recomputed afterward.
export async function runMatching(): Promise<MatchingSummary> {
    const gameResult = await matchGames();

    // Flags existing games that already combine a legacy-signal platform
    // link with a non-legacy one - a shape matchGames itself now refuses to
    // create, so any game already in it was very likely merged before that
    // exclusion existed (see #230). Detection only; a human reviews and
    // splits via the existing undo path, same as game merge candidates.
    const splitDetectResult = await detectLegacySignalSplitCandidates();

    // Backfills real Steam/Xbox/RetroAchievements achievement/rarity data
    // for games no user has actually linked that platform for - runs before
    // achievement matching below so anything added gets a chance to be
    // merged (and inherit a real tier) in the same pass, rather than
    // sitting unmatched until the next run.
    const catalogResult = await enrichGamesWithSteamCatalog();
    const xboxCatalogResult = await enrichGamesWithXboxCatalog();
    const retroCatalogResult = await enrichGamesWithRetroCatalog();

    const achievementResult = await matchAchievementsForAllGames();

    // Merges can shift a game's rarity_fallback achievement set (fewer,
    // combined rows), so re-check every game for the skew that drives
    // per-game percentile tiering (see rarityNormalization.ts, issue #10)
    // before scores are recomputed below.
    await normalizeRarityTiersForAllGames();

    const users = await pool.query("select id from users");
    for (const user of users.rows) {
        await recomputeUserScore(user.id);
    }

    return {
        gameGroupsMerged: gameResult.groupsMerged,
        gamesRemoved: gameResult.gamesRemoved,
        gameCandidatesRecorded: gameResult.candidatesRecorded,
        steamCatalogGamesEnriched: catalogResult.gamesEnriched,
        xboxCatalogGamesEnriched: xboxCatalogResult.gamesEnriched,
        retroCatalogGamesEnriched: retroCatalogResult.gamesEnriched,
        achievementsMerged: achievementResult.achievementsMerged,
        achievementCandidatesRecorded: achievementResult.candidatesRecorded,
        gameSplitCandidatesRecorded: splitDetectResult.candidatesRecorded,
        usersRescored: users.rows.length,
    };
}

// Called from every platform's on-demand /sync route (not from
// runAccountSync/scheduler.ts itself - the scheduler already batches this
// into one runMatching() call after every account finishes, and having
// runAccountSync call it too would re-run the whole-library job once per
// account instead of once per batch). Without this, a newly-synced game that
// exists on another already-linked platform sits unmatched - e.g. a rarity-
// fallback achievement on one platform stays at its guessed tier even when
// this same user's PSN account already has the real trophy tier for it -
// until someone remembers to hit "Link games" or POST /api/matching/run
// manually.
export async function runMatchingAndGetScore(userId: string): Promise<UserScore> {
    await runMatching();
    return getUserScore(userId);
}
