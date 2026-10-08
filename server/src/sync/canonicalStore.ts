import { pool } from "../db";
import { resolveTierFromRarity, TIER_POINTS } from "../scoring/tier";

// Shared by every platform's sync job: finds or creates the canonical
// games/achievements rows a platform-specific achievement should attach to.
// See docs/data-model.md for why canonical + link tables exist at all.

export async function getOrCreateCanonicalGame(
    platformId: string,
    platformGameId: string,
    title: string,
    coverImageUrl?: string,
    consoleVariant?: string
): Promise<string> {
    const existing = await pool.query(
        "select game_id from game_platform_links where platform_id = $1 and platform_game_id = $2",
        [platformId, platformGameId]
    );
    if (existing.rows[0]) {
        // Opportunistic backfill - a game created by a platform with no
        // usable cover art can still pick one up later from a different
        // platform's sync, but an existing image is never replaced (no
        // platform's art is treated as more authoritative than another's).
        if (coverImageUrl) {
            await pool.query("update games set cover_image_url = $1 where id = $2 and cover_image_url is null", [
                coverImageUrl,
                existing.rows[0].game_id,
            ]);
        }
        // console_variant lives on the platform link itself (it's tagging
        // "this platform's copy", not the shared canonical game), but still
        // never overwritten once set for the same reason as cover art above.
        if (consoleVariant) {
            await pool.query(
                "update game_platform_links set console_variant = $1 where platform_id = $2 and platform_game_id = $3 and console_variant is null",
                [consoleVariant, platformId, platformGameId]
            );
        }
        return existing.rows[0].game_id;
    }

    const client = await pool.connect();
    try {
        await client.query("begin");
        const game = await client.query("insert into games (title, cover_image_url) values ($1, $2) returning id", [
            title.trim(), // some platforms pad titles and names (see #364)
            coverImageUrl ?? null,
        ]);
        await client.query(
            `insert into game_platform_links (game_id, platform_id, platform_game_id, platform_title, console_variant)
             values ($1, $2, $3, $4, $5)`,
            [game.rows[0].id, platformId, platformGameId, title, consoleVariant ?? null]
        );
        await client.query("commit");
        return game.rows[0].id;
    } catch (err) {
        await client.query("rollback");
        throw err;
    } finally {
        client.release();
    }
}

// A game's own PlayStation trophy grade: from PSN, or from RPCS3's copy of
// the same PS3 trophy list (see #522).
export interface NativeTier {
    tier: string;
    tierSource: "psn_native";
}

export async function getOrCreateAchievementLink(
    gameId: string,
    platformId: string,
    platformGameId: string,
    platformAchievementId: string,
    name: string,
    description: string | undefined,
    globalRarity: number | undefined,
    nativeTier?: NativeTier,
    iconUrl?: string
): Promise<string> {
    // Platform achievement IDs are typically only unique within one game
    // (e.g. Steam's api names, Xbox's small per-title integer IDs), so the
    // lookup must be scoped by the platform's game ID too.
    const existing = await pool.query(
        "select id, canonical_achievement_id from achievement_platform_links where platform_id = $1 and platform_game_id = $2 and platform_achievement_id = $3",
        [platformId, platformGameId, platformAchievementId]
    );
    if (existing.rows[0]) {
        // Same opportunistic backfill as getOrCreateCanonicalGame above -
        // achievement rows created before this field existed (or by a
        // platform with no icon data) can still pick one up on a later sync.
        if (iconUrl) {
            await pool.query("update canonical_achievements set icon_url = $1 where id = $2 and icon_url is null", [
                iconUrl,
                existing.rows[0].canonical_achievement_id,
            ]);
        }
        return existing.rows[0].id;
    }

    // PSN's own trophy tier is authoritative when available (see
    // docs/data-model.md) - every other platform's tier is inferred from
    // global unlock rarity since there's no native tier to trust.
    const { tier, tierSource, points } = nativeTier
        ? { tier: nativeTier.tier, tierSource: nativeTier.tierSource, points: TIER_POINTS[nativeTier.tier] }
        : { ...resolveTierFromRarity(globalRarity), tierSource: "rarity_fallback" as const };

    const client = await pool.connect();
    try {
        await client.query("begin");
        const canonical = await client.query(
            `insert into canonical_achievements (game_id, name, description, tier, tier_source, points, icon_url)
             values ($1, $2, $3, $4, $5, $6, $7) returning id`,
            [gameId, name.trim(), description ?? null, tier, tierSource, points, iconUrl ?? null]
        );
        const link = await client.query(
            `insert into achievement_platform_links
                (canonical_achievement_id, platform_id, platform_game_id, platform_achievement_id, platform_name, platform_description, global_unlock_rarity)
             values ($1, $2, $3, $4, $5, $6, $7) returning id`,
            [canonical.rows[0].id, platformId, platformGameId, platformAchievementId, name, description ?? null, globalRarity ?? null]
        );
        await client.query("commit");
        return link.rows[0].id;
    } catch (err) {
        await client.query("rollback");
        throw err;
    } finally {
        client.release();
    }
}

export async function recordOwnership(userPlatformAccountId: string, gameId: string): Promise<void> {
    await pool.query(
        `insert into user_owned_games (user_platform_account_id, game_id)
         values ($1, $2)
         on conflict (user_platform_account_id, game_id) do nothing`,
        [userPlatformAccountId, gameId]
    );
}

// Returns true if this was a newly recorded unlock (false if already existed).
// unlockedAt is null when the platform gives no trustworthy time: stamping
// the sync time instead made years-old unlocks look brand new (see #423). An
// unknown date is filled in if a later sync does get one.
export async function recordUnlock(
    userPlatformAccountId: string,
    achievementLinkId: string,
    unlockedAt: Date | null
): Promise<boolean> {
    const result = await pool.query(
        `insert into user_achievement_unlocks (user_platform_account_id, achievement_platform_link_id, unlocked_at)
         values ($1, $2, $3)
         on conflict (user_platform_account_id, achievement_platform_link_id) do update
            set unlocked_at = excluded.unlocked_at
            where user_achievement_unlocks.unlocked_at is null and excluded.unlocked_at is not null
         returning (xmax = 0) as inserted`,
        [userPlatformAccountId, achievementLinkId, unlockedAt]
    );
    return result.rows[0]?.inserted === true;
}

// recordUnlock's own ON CONFLICT DO NOTHING means an unlock, once recorded,
// is never touched again by a normal sync - correct for the common case
// (achievements don't usually un-unlock), but a platform can legitimately
// report a previously-earned achievement as no longer achieved: a Steam
// stats reset, or achievements unlocked and later removed with a tool like
// Steam Achievement Manager (see #57). Every platform's sync calls this when
// it sees "not achieved" for something, so a reversal actually corrects the
// stored unlock instead of leaving it credited forever. A no-op (and cheap
// - an indexed delete) for the overwhelmingly common case where nothing was
// ever recorded for this achievement to begin with.
export async function revokeUnlockIfPresent(userPlatformAccountId: string, achievementLinkId: string): Promise<boolean> {
    const result = await pool.query(
        `delete from user_achievement_unlocks
         where user_platform_account_id = $1 and achievement_platform_link_id = $2
         returning id`,
        [userPlatformAccountId, achievementLinkId]
    );
    return result.rows.length > 0;
}

// Maps a platform's raw owned-game IDs (appids, titleIds, etc.) to the
// canonical games already linked for them. Used by reconcileMissingOwnership
// below to see what a platform currently reports as owned independent of any
// per-sync achievement-fetch skip-cache (see steam/sync.ts) - a game a
// platform still lists is never "missing" even if this sync skipped
// re-fetching its achievements.
export async function getCanonicalGameIdsForPlatformGames(platformId: string, platformGameIds: string[]): Promise<string[]> {
    if (platformGameIds.length === 0) return [];
    const result = await pool.query(
        "select distinct game_id from game_platform_links where platform_id = $1 and platform_game_id = any($2::text[])",
        [platformId, platformGameIds]
    );
    return result.rows.map((r) => r.game_id);
}

// A previously-owned game has to be missing from this many consecutive syncs
// in a row before it's treated as a genuine removal rather than a transient
// API hiccup or partial/paginated response (see #58).
const MISSING_SYNC_THRESHOLD = 3;

export interface ReconciliationResult {
    gamesReconciled: number;
    achievementsRevoked: number;
}

// See #58: revoking every achievement for a game the instant it's absent
// from one sync's owned-games response is too risky - a flaky API call could
// wipe out real progress for a whole library. Instead this tracks consecutive
// absences per (account, game) and only reconciles (revokes this account's
// unlocks for it and drops it from user_owned_games) once a game has been
// missing MISSING_SYNC_THRESHOLD syncs running. A game seen again before
// that resets its streak back to zero.
export async function reconcileMissingOwnership(
    userPlatformAccountId: string,
    currentlyOwnedGameIds: string[]
): Promise<ReconciliationResult> {
    const client = await pool.connect();
    try {
        await client.query("begin");

        // Serializes every reconciliation call for the same account (the
        // background scheduler and a manual/"sync all" sync can otherwise run
        // concurrently) so two overlapping syncs can't each increment the same
        // game's absence streak or race the revoke/delete statements below.
        // xact-scoped: released automatically on commit/rollback, so a crash
        // or dropped connection can't leave it held.
        await client.query("select pg_advisory_xact_lock(hashtext('game_absence_streaks'), hashtext($1))", [
            userPlatformAccountId,
        ]);

        if (currentlyOwnedGameIds.length > 0) {
            await client.query(
                `delete from game_absence_streaks
                 where user_platform_account_id = $1 and game_id = any($2::uuid[])`,
                [userPlatformAccountId, currentlyOwnedGameIds]
            );
        }

        const previouslyOwned = await client.query(
            "select game_id from user_owned_games where user_platform_account_id = $1",
            [userPlatformAccountId]
        );

        // A platform reporting zero owned games while we previously tracked
        // some is far more likely a soft failure (expired token, an empty
        // paginated page) than a real "now owns nothing" - the per-game
        // streak alone can't tell those apart, so skip reconciling entirely
        // this sync rather than risk treating a whole library as missing
        // (see #58's original risk, just spread across 3 syncs instead of 1).
        if (currentlyOwnedGameIds.length === 0 && previouslyOwned.rows.length > 0) {
            await client.query("commit");
            return { gamesReconciled: 0, achievementsRevoked: 0 };
        }

        const currentSet = new Set(currentlyOwnedGameIds);
        const missingGameIds = previouslyOwned.rows.map((r) => r.game_id).filter((gameId) => !currentSet.has(gameId));

        if (missingGameIds.length === 0) {
            await client.query("commit");
            return { gamesReconciled: 0, achievementsRevoked: 0 };
        }

        const streaks = await client.query(
            `insert into game_absence_streaks (user_platform_account_id, game_id, consecutive_missing_syncs)
             select $1, gid, 1 from unnest($2::uuid[]) as gid
             on conflict (user_platform_account_id, game_id)
             do update set consecutive_missing_syncs = game_absence_streaks.consecutive_missing_syncs + 1
             returning game_id, consecutive_missing_syncs`,
            [userPlatformAccountId, missingGameIds]
        );
        const toReconcile = streaks.rows
            .filter((r) => r.consecutive_missing_syncs >= MISSING_SYNC_THRESHOLD)
            .map((r) => r.game_id);

        let gamesReconciled = 0;
        let achievementsRevoked = 0;

        if (toReconcile.length > 0) {
            const revoked = await client.query(
                `delete from user_achievement_unlocks
                 where user_platform_account_id = $1
                   and achievement_platform_link_id in (
                       select apl.id from achievement_platform_links apl
                       join canonical_achievements ca on ca.id = apl.canonical_achievement_id
                       where ca.game_id = any($2::uuid[])
                   )
                 returning id`,
                [userPlatformAccountId, toReconcile]
            );
            achievementsRevoked = revoked.rows.length;
            gamesReconciled = toReconcile.length;

            await client.query(
                "delete from user_owned_games where user_platform_account_id = $1 and game_id = any($2::uuid[])",
                [userPlatformAccountId, toReconcile]
            );
            await client.query(
                "delete from game_absence_streaks where user_platform_account_id = $1 and game_id = any($2::uuid[])",
                [userPlatformAccountId, toReconcile]
            );
        }

        await client.query("commit");
        return { gamesReconciled, achievementsRevoked };
    } catch (err) {
        await client.query("rollback");
        throw err;
    } finally {
        client.release();
    }
}

// Shared by every platform's sync job: maps its raw owned-game-id list to
// canonical games and reconciles ownership in one call, instead of each
// sync.ts repeating the getCanonicalGameIdsForPlatformGames +
// reconcileMissingOwnership pair by hand.
export async function reconcileOwnershipForPlatform(
    userPlatformAccountId: string,
    platformId: string,
    platformGameIds: string[]
): Promise<ReconciliationResult> {
    const currentlyOwnedGameIds = await getCanonicalGameIdsForPlatformGames(platformId, platformGameIds);
    return reconcileMissingOwnership(userPlatformAccountId, currentlyOwnedGameIds);
}
