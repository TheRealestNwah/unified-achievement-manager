import { pool } from "../db";
import { CROSS_GAME_PENDING_CANDIDATES } from "./achievementMatcher";

export class GameSplitError extends Error {}

export interface GameSplitResult {
    newGameId: string;
    achievementsMoved: number;
    achievementsCopied: number;
}

// Undoes a merge one platform list at a time (see #169) - the general form
// of db/splitSkyrimSpecialEditionPsn.ts. mergeGames deletes the losing games
// row, so there is nothing to restore; instead the chosen
// game_platform_links row gets a fresh canonical game of its own.
//
// Achievements from that list move with it. A canonical achievement that
// matching fused with another platform's copy is duplicated instead, so the
// platforms left behind keep theirs. Unlocks are keyed by
// achievement_platform_links.id, which never changes here, so nobody loses
// progress.
export async function splitPlatformLink(gameId: string, gamePlatformLinkId: string): Promise<GameSplitResult> {
    const client = await pool.connect();
    try {
        await client.query("begin");

        const link = await client.query(
            "select id, game_id, platform_id, platform_game_id, platform_title from game_platform_links where id = $1 for update",
            [gamePlatformLinkId]
        );
        if (!link.rows[0] || link.rows[0].game_id !== gameId) {
            throw new GameSplitError("That platform entry isn't part of this game");
        }
        const { platform_id: platformId, platform_game_id: platformGameId, platform_title: platformTitle } = link.rows[0];

        const remaining = await client.query(
            "select platform_id from game_platform_links where game_id = $1 and id != $2",
            [gameId, gamePlatformLinkId]
        );
        if (remaining.rows.length === 0) {
            throw new GameSplitError("This game only has one platform entry - there's nothing to split it from");
        }
        const platformStaysOnSource = remaining.rows.some((r) => r.platform_id === platformId);

        const created = await client.query("insert into games (title) values ($1) returning id", [platformTitle.trim()]);
        const newGameId: string = created.rows[0].id;
        await client.query("update game_platform_links set game_id = $1 where id = $2", [newGameId, gamePlatformLinkId]);

        let achievementsMoved = 0;
        let achievementsCopied = 0;
        const canonicalRows = await client.query(
            `select distinct canonical_achievement_id as id from achievement_platform_links
             where platform_id = $1 and platform_game_id = $2`,
            [platformId, platformGameId]
        );
        for (const { id: canonicalId } of canonicalRows.rows) {
            const sharedElsewhere = await client.query(
                `select 1 from achievement_platform_links
                 where canonical_achievement_id = $1 and not (platform_id = $2 and platform_game_id = $3)
                 limit 1`,
                [canonicalId, platformId, platformGameId]
            );
            if (sharedElsewhere.rows.length === 0) {
                await client.query("update canonical_achievements set game_id = $1 where id = $2", [newGameId, canonicalId]);
                achievementsMoved++;
                continue;
            }

            const copy = await client.query(
                `insert into canonical_achievements (game_id, name, description, tier, tier_source, points, icon_url)
                 select $1, name, description, tier, tier_source, points, icon_url
                 from canonical_achievements where id = $2
                 returning id`,
                [newGameId, canonicalId]
            );
            const copyId: string = copy.rows[0].id;
            await client.query(
                `update achievement_platform_links set canonical_achievement_id = $1
                 where canonical_achievement_id = $2 and platform_id = $3 and platform_game_id = $4`,
                [copyId, canonicalId, platformId, platformGameId]
            );
            // A custom icon someone picked for the fused row still applies
            // to both halves.
            await client.query(
                `insert into user_achievement_icon_overrides (user_id, canonical_achievement_id, icon_url)
                 select user_id, $1, icon_url from user_achievement_icon_overrides where canonical_achievement_id = $2`,
                [copyId, canonicalId]
            );
            achievementsCopied++;
        }

        if (platformStaysOnSource) {
            // Another list on the same platform (e.g. PS3 and PS5 trophy
            // lists) stays behind, so a source ownership row can't tell which
            // one an account owns. Only unlocks on the split list prove it;
            // anyone else gets ownership back on their next sync.
            await client.query(
                `insert into user_owned_games (user_platform_account_id, game_id)
                 select distinct uau.user_platform_account_id, $1::uuid
                 from user_achievement_unlocks uau
                 join achievement_platform_links apl on apl.id = uau.achievement_platform_link_id
                 where apl.platform_id = $2 and apl.platform_game_id = $3
                 on conflict (user_platform_account_id, game_id) do nothing`,
                [newGameId, platformId, platformGameId]
            );
        } else {
            // The source game no longer has anything on this platform, so
            // every one of that platform's owners and absence streaks move.
            for (const table of ["user_owned_games", "game_absence_streaks"]) {
                await client.query(
                    `update ${table} t set game_id = $1
                     from user_platform_accounts upa
                     where upa.id = t.user_platform_account_id and upa.platform_id = $2 and t.game_id = $3`,
                    [newGameId, platformId, gameId]
                );
            }
        }

        // Without this, the next matching run would suggest (or, on an exact
        // title, silently redo) the merge that was just undone.
        const [first, second] = [gameId, newGameId].sort();
        await client.query(
            `insert into game_merge_candidates (game_a_id, game_b_id, confidence, reason, status, reviewed_at)
             values ($1, $2, 1, 'manual-split', 'rejected', now())
             on conflict (game_a_id, game_b_id) do update set status = 'rejected', reviewed_at = now()`,
            [first, second]
        );

        // Matches still waiting for review between the two halves now pair
        // achievements from different games (see #360).
        await client.query(`delete from achievement_match_candidates where id in (${CROSS_GAME_PENDING_CANDIDATES})`);
        await client.query("commit");
        return { newGameId, achievementsMoved, achievementsCopied };
    } catch (err) {
        await client.query("rollback");
        throw err;
    } finally {
        client.release();
    }
}
