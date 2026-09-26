import { pool } from "../db";
import { RETRO_PLATFORM_ID, isLegacyOnlyLink } from "./gameMatcher";
import { splitPlatformLink, GameSplitResult } from "./gameSplitter";

export interface LegacySignalSplitDetectResult {
    candidatesRecorded: number;
}

interface LinkRow {
    id: string;
    gameId: string;
    platformId: string;
    consoleVariant: string | null;
}

function isLegacySignalLink(link: LinkRow): boolean {
    return link.platformId === RETRO_PLATFORM_ID || isLegacyOnlyLink(link.platformId, link.consoleVariant);
}

// Finds games that already combine a legacy-signal platform link with a
// non-legacy one - the exact shape matchGames' auto-merge refuses to create
// today (see gameMatcher.ts), so any game already in this shape was almost
// certainly merged before that exclusion existed, and is worth a human
// double-check via the split-candidate review queue. Idempotent: a link
// already recorded (pending, confirmed, or rejected) isn't re-inserted, same
// pattern as recordGameCandidate in gameMatcher.ts.
export async function detectLegacySignalSplitCandidates(): Promise<LegacySignalSplitDetectResult> {
    const rows = await pool.query(`
        select id, game_id, platform_id, console_variant
        from game_platform_links
    `);
    const links: LinkRow[] = rows.rows.map((r) => ({
        id: r.id,
        gameId: r.game_id,
        platformId: r.platform_id,
        consoleVariant: r.console_variant,
    }));

    const byGame = new Map<string, LinkRow[]>();
    for (const link of links) {
        const list = byGame.get(link.gameId) ?? [];
        list.push(link);
        byGame.set(link.gameId, list);
    }

    let candidatesRecorded = 0;
    for (const gameLinks of byGame.values()) {
        if (gameLinks.length < 2) continue;

        const legacyLinks = gameLinks.filter(isLegacySignalLink);
        const safeLinks = gameLinks.filter((l) => !isLegacySignalLink(l));
        if (legacyLinks.length === 0 || safeLinks.length === 0) continue;

        for (const legacyLink of legacyLinks) {
            const reason = legacyLink.platformId === RETRO_PLATFORM_ID ? "exact-title-retro" : "exact-title-legacy-platform";
            const created = await pool.query(
                `insert into game_split_candidates (game_id, game_platform_link_id, reason)
                 values ($1, $2, $3)
                 on conflict (game_platform_link_id) do nothing
                 returning id`,
                [legacyLink.gameId, legacyLink.id, reason]
            );
            if (created.rows.length > 0) candidatesRecorded++;
        }
    }

    return { candidatesRecorded };
}

export async function confirmGameSplitCandidate(candidateId: string): Promise<GameSplitResult> {
    const candidate = await pool.query(
        "select game_id, game_platform_link_id from game_split_candidates where id = $1",
        [candidateId]
    );
    if (!candidate.rows[0]) throw new Error("Game split candidate not found");

    const result = await splitPlatformLink(candidate.rows[0].game_id, candidate.rows[0].game_platform_link_id);
    await pool.query("update game_split_candidates set status = 'confirmed', reviewed_at = now() where id = $1", [
        candidateId,
    ]);
    return result;
}

export async function rejectGameSplitCandidate(candidateId: string): Promise<void> {
    await pool.query("update game_split_candidates set status = 'rejected', reviewed_at = now() where id = $1", [
        candidateId,
    ]);
}
