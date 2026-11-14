import { beforeEach, describe, expect, it, vi } from "vitest";

// The Steam adapter with its client and rarity cache stubbed: no network, no
// database.
const client = vi.hoisted(() => ({
    getOwnedGames: vi.fn(),
    getSchemaForGame: vi.fn(),
    getPlayerAchievements: vi.fn(),
}));
vi.mock("./client", () => client);
const getCachedGlobalPercentages = vi.hoisted(() => vi.fn());
vi.mock("./globalRarityCache", () => ({ getCachedGlobalPercentages }));

import { steamAdapter } from "./adapter";

const account = { platformAccountId: "steam-id", accessToken: null, refreshToken: null, localFolder: null };

beforeEach(() => {
    vi.resetAllMocks();
    client.getOwnedGames.mockResolvedValue([{ appid: 620, name: "Portal 2", playtime_forever: 90, rtime_last_played: 1700000000 }]);
    getCachedGlobalPercentages.mockResolvedValue(new Map([["ACH_A", 42.5]]));
});

describe("Steam adapter", () => {
    it("marks each owned game with its playtime and last-played time", async () => {
        const session = await steamAdapter.connect(account);
        expect(await session.listOwnedGames()).toEqual([
            { platformGameId: "620", changeMarker: "90:1700000000", details: expect.objectContaining({ name: "Portal 2" }) },
        ]);
        expect(client.getOwnedGames).toHaveBeenCalledWith("steam-id");
    });

    it("reports no achievements when the schema is empty", async () => {
        client.getSchemaForGame.mockResolvedValue([]);
        const session = await steamAdapter.connect(account);
        const [game] = await session.listOwnedGames();
        expect(await session.fetchAchievementList(game)).toEqual({ kind: "none" });
        expect(client.getPlayerAchievements).not.toHaveBeenCalled();
    });

    it("maps the schema, unlocks and global rarity", async () => {
        client.getSchemaForGame.mockResolvedValue([
            { name: "ACH_A", displayName: "A", description: "Do A", iconUrl: "a.jpg" },
            { name: "ACH_B", displayName: "B" },
            { name: "ACH_C", displayName: "C" },
        ]);
        client.getPlayerAchievements.mockResolvedValue([
            { apiname: "ACH_A", achieved: 1, unlocktime: 1700000000 },
            { apiname: "ACH_B", achieved: 0, unlocktime: 0 },
            { apiname: "ACH_C", achieved: 1, unlocktime: 0 },
        ]);
        const session = await steamAdapter.connect(account);
        const [game] = await session.listOwnedGames();

        expect(await session.fetchAchievementList(game)).toEqual({
            kind: "achievements",
            title: "Portal 2",
            coverImageUrl: "https://cdn.cloudflare.steamstatic.com/steam/apps/620/library_600x900.jpg",
            achievements: [
                { id: "ACH_A", name: "A", description: "Do A", rarity: 42.5, iconUrl: "a.jpg", unlocked: true, unlockedAt: new Date(1700000000 * 1000) },
                { id: "ACH_B", name: "B", description: undefined, rarity: undefined, iconUrl: undefined, unlocked: false, unlockedAt: null },
                // Steam's 0 means no date worth trusting (#423).
                { id: "ACH_C", name: "C", description: undefined, rarity: undefined, iconUrl: undefined, unlocked: true, unlockedAt: null },
            ],
        });
        expect(client.getPlayerAchievements).toHaveBeenCalledWith(620, "steam-id");
    });
});
