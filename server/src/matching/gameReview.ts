import { pool } from "../db";
import { matchAchievementsForGame } from "./achievementMatcher";
import { confirmGameMergeCandidate, rejectGameMergeCandidate } from "./gameMatcher";
import { confirmGameSplitCandidate, rejectGameSplitCandidate } from "./legacySignalSplitDetector";
import { GameSplitError, type GameSplitResult } from "./gameSplitter";
import { recomputeUserScore } from "../scoring";
import { normalizeRarityTiersForGame } from "../scoring/rarityNormalization";

// Confirm/reject for the Game merges and Possible bad merges review queues,
// one at a time or in bulk (see #293). Each confirm returns the games it
// changed; rescoring runs once for all of them afterwards, which is what
// makes a bulk batch cheaper than clicking through it.

export type ReviewAction = "confirm" | "reject";
export type GameReviewQueue = "merge" | "split";

const TABLES: Record<GameReviewQueue, string> = { merge: "game_merge_candidates", split: "game_split_candidates" };

async function isPending(queue: GameReviewQueue, id: string): Promise<boolean> {
    const result = await pool.query(`select status from ${TABLES[queue]} where id = $1`, [id]);
    return result.rows[0]?.status === "pending";
}

// Merges the pair into game A, then re-runs achievement matching and
// rarity tiering for just that game. Returns the game that changed.
export async function confirmGameMerge(id: string): Promise<string[]> {
    const candidate = await pool.query("select game_a_id from game_merge_candidates where id = $1", [id]);
    if (!candidate.rows[0]) throw new Error("Game merge candidate not found");
    const keepGameId: string = candidate.rows[0].game_a_id;
    await confirmGameMergeCandidate(id);
    await matchAchievementsForGame(keepGameId);
    await normalizeRarityTiersForGame(keepGameId);
    return [keepGameId];
}

// Splits the flagged platform entry into its own game. Returns both games.
export async function confirmGameSplit(id: string): Promise<GameSplitResult & { changedGameIds: string[] }> {
    const candidate = await pool.query("select game_id from game_split_candidates where id = $1", [id]);
    if (!candidate.rows[0]) throw new Error("Game split candidate not found");
    const sourceGameId: string = candidate.rows[0].game_id;
    const result = await confirmGameSplitCandidate(id);
    await normalizeRarityTiersForGame(sourceGameId);
    await normalizeRarityTiersForGame(result.newGameId);
    return { ...result, changedGameIds: [sourceGameId, result.newGameId] };
}

export async function rescoreOwnersOf(gameIds: string[]): Promise<number> {
    if (gameIds.length === 0) return 0;
    const users = await pool.query(
        `select distinct upa.user_id from user_owned_games uog
         join user_platform_accounts upa on upa.id = uog.user_platform_account_id
         where uog.game_id = any($1::uuid[])`,
        [gameIds]
    );
    for (const user of users.rows) await recomputeUserScore(user.user_id);
    return users.rows.length;
}

// Skips anything no longer pending - an earlier merge in the same batch can
// already have removed a later candidate's game.
export async function resolveGameReviewBatch(
    queue: GameReviewQueue,
    ids: string[],
    action: ReviewAction
): Promise<{ resolved: number; skipped: number; failed: number }> {
    let resolved = 0;
    let skipped = 0;
    let failed = 0;
    const changed = new Set<string>();
    for (const id of ids) {
        if (!(await isPending(queue, id))) {
            skipped++;
            continue;
        }
        try {
            if (action === "reject") {
                await (queue === "merge" ? rejectGameMergeCandidate(id) : rejectGameSplitCandidate(id));
            } else if (queue === "merge") {
                (await confirmGameMerge(id)).forEach((g) => changed.add(g));
            } else {
                (await confirmGameSplit(id)).changedGameIds.forEach((g) => changed.add(g));
            }
            resolved++;
        } catch (err) {
            // One bad split (e.g. the game no longer has that entry) shouldn't
            // stop the rest of the batch.
            if (!(err instanceof GameSplitError)) console.error(`Bulk ${action} of ${queue} candidate ${id} failed:`, err);
            failed++;
        }
    }
    // Only games that still exist - a later merge can delete an earlier one's game.
    const existing = await pool.query("select id from games where id = any($1::uuid[])", [[...changed]]);
    await rescoreOwnersOf(existing.rows.map((r) => r.id));
    return { resolved, skipped, failed };
}

// Undo for a rejection: puts it back in its queue.
export async function reopenGameReviewCandidate(queue: GameReviewQueue, id: string): Promise<boolean> {
    const result = await pool.query(
        `update ${TABLES[queue]} set status = 'pending', reviewed_at = null where id = $1 and status = 'rejected'`,
        [id]
    );
    return (result.rowCount ?? 0) > 0;
}
