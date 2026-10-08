import path from "path";
import { pool } from "../db";
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
import { listTrophyFolders } from "./folder";
import { readTrophySet, Rpcs3TrophySet } from "./trophyFiles";

// RPCS3's icons stay in its own folder and are served from there (see
// routes.ts), so nothing is copied.
export function rpcs3IconUrl(communicationId: string, file: string | null): string | undefined {
    return file ? `/rpcs3-icons/${communicationId}/${file}` : undefined;
}

// Syncs one RPCS3 user's trophies from the RPCS3 folder (see #522). Each
// trophy folder is one game, keyed by its NP communication ID - the same ID
// PSN uses for the game's trophy list.
export async function syncRpcs3Account(userPlatformAccountId: string, folder: string, rpcs3UserId: string): Promise<SyncSummary> {
    const folders = listTrophyFolders(folder, rpcs3UserId);
    let gamesProcessed = 0;
    let achievementsUnlocked = 0;
    let achievementsRevoked = 0;

    for (const gameFolder of folders) {
        let set: Rpcs3TrophySet;
        try {
            set = await readTrophySet(gameFolder);
        } catch (err) {
            // Missing files, or RPCS3 writing them right now. Skipped this
            // time and still counted as owned below, so its unlocks stay.
            console.warn(`RPCS3: skipped ${path.basename(gameFolder)}: ${err instanceof Error ? err.message : err}`);
            continue;
        }

        const gameId = await getOrCreateCanonicalGame("rpcs3", set.communicationId, set.title, rpcs3IconUrl(set.communicationId, set.iconFile));
        await recordOwnership(userPlatformAccountId, gameId);
        gamesProcessed++;

        for (const trophy of set.trophies) {
            const linkId = await getOrCreateAchievementLink(
                gameId,
                "rpcs3",
                set.communicationId,
                String(trophy.id),
                trophy.name,
                trophy.detail,
                undefined,
                // The game's own PlayStation trophy grades, as on PSN.
                { tier: trophy.grade, tierSource: "psn_native" },
                rpcs3IconUrl(set.communicationId, trophy.iconFile)
            );

            if (!trophy.unlocked) {
                if (await revokeUnlockIfPresent(userPlatformAccountId, linkId)) achievementsRevoked++;
                continue;
            }
            if (await recordUnlock(userPlatformAccountId, linkId, trophy.unlockedAt)) achievementsUnlocked++;
        }

        await normalizeRarityTiersForGame(gameId);
    }

    const { gamesReconciled, achievementsRevoked: reconciledRevocations } = await reconcileOwnershipForPlatform(
        userPlatformAccountId,
        "rpcs3",
        folders.map((f) => path.basename(f))
    );
    achievementsRevoked += reconciledRevocations;

    await pool.query("update user_platform_accounts set last_synced_at = now() where id = $1", [userPlatformAccountId]);

    return { gamesProcessed, achievementsUnlocked, achievementsRevoked, gamesReconciled };
}
