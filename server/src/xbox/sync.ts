import { pool } from "../db";
import { getTitles, getAchievementsForTitle, getX360AchievementsForTitle } from "./client";
import {
    getOrCreateCanonicalGame,
    getOrCreateAchievementLink,
    recordUnlock,
    revokeUnlockIfPresent,
    recordOwnership,
    reconcileOwnershipForPlatform,
} from "../sync/canonicalStore";
import { normalizeRarityTiersForGame } from "../scoring/rarityNormalization";
import { SyncSummary } from "../sync/types";

async function getSyncState(userPlatformAccountId: string): Promise<Map<string, string>> {
    const result = await pool.query("select title_id, progress from xbox_title_sync_state where user_platform_account_id = $1", [
        userPlatformAccountId,
    ]);
    return new Map(result.rows.map((r) => [r.title_id, r.progress]));
}

async function saveSyncState(userPlatformAccountId: string, titleId: string, progress: string | undefined) {
    if (progress === undefined) return;
    await pool.query(
        `insert into xbox_title_sync_state (user_platform_account_id, title_id, progress)
         values ($1, $2, $3)
         on conflict (user_platform_account_id, title_id) do update set progress = excluded.progress`,
        [userPlatformAccountId, titleId, progress]
    );
}

export async function syncXboxAccount(userPlatformAccountId: string, apiKey: string, xuid: string): Promise<SyncSummary> {
    const titles = await getTitles(apiKey);
    const syncState = await getSyncState(userPlatformAccountId);
    let achievementsUnlocked = 0;
    let achievementsRevoked = 0;
    let gamesProcessed = 0;

    for (const title of titles) {
        if (title.totalAchievements === 0) continue;
        // Same idea as Steam's playtime skip: a title's unlocked count,
        // gamerscore, and last-played time can't all stay put while its
        // unlocks change, so there's nothing to re-fetch (see #384). A
        // revoked achievement lowers the count, so #57 still gets caught.
        // Trade-off, as on Steam: rarity for a title nobody has played since
        // stays as of the last fetch.
        if (title.progress !== undefined && syncState.get(title.titleId) === title.progress) continue;

        let achievements = await getAchievementsForTitle(apiKey, title.titleId);
        // Which endpoint actually had data doubles as the only reliable
        // console-generation signal OpenXBL gives us - see #36. The
        // `devices` field on /v2/titles reports backward-compatibility, not
        // origin generation (a classic 360 title playable via compat on
        // newer consoles lists all three), so it can't tell One from Series.
        // This can: only classic 360 titles fall through to the legacy
        // endpoint, which is a real, already-verified signal, just not a
        // 3-way split - and it can't tell PC from console at all, since the
        // Xbox app on PC uses the same modern achievements endpoint as
        // Xbox One/Series (see #77). No variant label for that ambiguous
        // case rather than a claim we can't back up - "Xbox 360" is left as
        // the one case where this signal is actually reliable.
        let consoleVariant: string | undefined;
        if (achievements.length === 0) {
            // Classic Xbox 360 titles use a separate legacy achievements
            // contract - see getX360AchievementsForTitle for what's different.
            achievements = await getX360AchievementsForTitle(apiKey, xuid, title.titleId);
            consoleVariant = "Xbox 360";
        }
        if (achievements.length === 0) {
            await saveSyncState(userPlatformAccountId, title.titleId, title.progress);
            continue;
        }

        const gameId = await getOrCreateCanonicalGame("xbox", title.titleId, title.name, title.coverImageUrl, consoleVariant);
        await recordOwnership(userPlatformAccountId, gameId);
        gamesProcessed++;

        for (const achievement of achievements) {
            const linkId = await getOrCreateAchievementLink(
                gameId,
                "xbox",
                title.titleId,
                achievement.id,
                achievement.name,
                achievement.description,
                achievement.rarityPercent,
                undefined,
                achievement.iconUrl
            );

            if (!achievement.isUnlocked) {
                // See #57 - correct a previously recorded unlock if Xbox
                // now reports this as not achieved, rather than leaving it
                // credited forever.
                if (await revokeUnlockIfPresent(userPlatformAccountId, linkId)) achievementsRevoked++;
                continue;
            }

            const isNew = await recordUnlock(
                userPlatformAccountId,
                linkId,
                achievement.timeUnlocked ? new Date(achievement.timeUnlocked) : new Date()
            );
            if (isNew) achievementsUnlocked++;
        }

        await normalizeRarityTiersForGame(gameId);
        // Only once the title is fully recorded, so a sync cut off partway
        // (a 429 mid-run) fetches this title again next time.
        await saveSyncState(userPlatformAccountId, title.titleId, title.progress);
    }

    const { gamesReconciled, achievementsRevoked: reconciledRevocations } = await reconcileOwnershipForPlatform(
        userPlatformAccountId,
        "xbox",
        titles.map((t) => t.titleId)
    );
    achievementsRevoked += reconciledRevocations;

    await pool.query("update user_platform_accounts set last_synced_at = now() where id = $1", [
        userPlatformAccountId,
    ]);

    return { gamesProcessed, achievementsUnlocked, achievementsRevoked, gamesReconciled };
}
