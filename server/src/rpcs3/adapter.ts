import path from "path";
import { PlatformAdapter } from "../sync/platformAdapter";
import { listTrophyFolders } from "./folder";
import { readTrophySet } from "./trophyFiles";

// RPCS3's icons stay in its own folder and are served from there (see
// routes.ts), so nothing is copied.
export function rpcs3IconUrl(communicationId: string, file: string | null): string | undefined {
    return file ? `/rpcs3-icons/${communicationId}/${file}` : undefined;
}

// Reads one RPCS3 user's trophies from the RPCS3 folder (see #522). Each
// trophy folder is one owned game, named after its NP communication ID - the
// same ID PSN uses for the game's trophy list.
export const rpcs3Adapter: PlatformAdapter = {
    platformId: "rpcs3",

    async connect(account) {
        // A folder on this computer, not a login.
        const folder = account.localFolder;
        if (!folder) throw new Error("Pick your RPCS3 folder in Settings.");
        const gameFolders = new Map(listTrophyFolders(folder, account.platformAccountId).map((f) => [path.basename(f), f]));

        return {
            async listOwnedGames() {
                return [...gameFolders.keys()].map((platformGameId) => ({ platformGameId }));
            },

            async fetchAchievementList(game) {
                let set;
                try {
                    set = await readTrophySet(gameFolders.get(game.platformGameId)!);
                } catch (err) {
                    // Missing files, or RPCS3 writing them right now.
                    return { kind: "skip", reason: err instanceof Error ? err.message : String(err) };
                }
                return {
                    kind: "achievements",
                    title: set.title,
                    coverImageUrl: rpcs3IconUrl(set.communicationId, set.iconFile),
                    achievements: set.trophies.map((trophy) => ({
                        id: String(trophy.id),
                        name: trophy.name,
                        description: trophy.detail,
                        // The game's own PlayStation trophy grades, as on PSN.
                        nativeTier: { tier: trophy.grade, tierSource: "psn_native" },
                        iconUrl: rpcs3IconUrl(set.communicationId, trophy.iconFile),
                        unlocked: trophy.unlocked,
                        unlockedAt: trophy.unlockedAt,
                    })),
                };
            },
        };
    },
};
