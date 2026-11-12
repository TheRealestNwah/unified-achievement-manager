import { beforeEach, describe, expect, it, vi } from "vitest";

// The RetroAchievements adapter with its client stubbed: no network, no
// database. Each fetch still waits out the real request delay.
const client = vi.hoisted(() => ({
    getUserGames: vi.fn(),
    getGameProgress: vi.fn(),
}));
vi.mock("./client", () => client);

import { parseRetroDate, retroAdapter } from "./adapter";

const account = { id: "account", platformAccountId: "ra-user", accessToken: "ra-key", refreshToken: null, localFolder: null };

beforeEach(() => {
    vi.resetAllMocks();
    client.getUserGames.mockResolvedValue([{ gameId: "1446", title: "Sonic the Hedgehog", coverImageUrl: "sonic.png" }]);
});

async function connect() {
    const session = await retroAdapter.connect(account);
    const owned = await session.listOwnedGames();
    return { session, owned };
}

describe("RetroAchievements adapter", () => {
    it("lists owned games with the account's username and API key", async () => {
        const { owned } = await connect();
        expect(owned).toEqual([{ platformGameId: "1446" }]);
        expect(client.getUserGames).toHaveBeenCalledWith("ra-user", "ra-key");
    });

    it("reports no achievements for a game without any", async () => {
        client.getGameProgress.mockResolvedValue([]);
        const { session } = await connect();
        expect(await session.fetchAchievementList({ platformGameId: "1446" })).toEqual({ kind: "none" });
    });

    it("maps achievements, reading RA's timezone-less dates as UTC", async () => {
        client.getGameProgress.mockResolvedValue([
            { id: "1", name: "Ring Collector", description: "Get 100 rings", isUnlocked: true, unlockedAt: "2026-03-04 05:06:07", globalUnlockRarity: 30, iconUrl: "r.png" },
            { id: "2", name: "Speedrun", description: "Fast", isUnlocked: false },
        ]);
        const { session } = await connect();

        expect(await session.fetchAchievementList({ platformGameId: "1446" })).toEqual({
            kind: "achievements",
            title: "Sonic the Hedgehog",
            coverImageUrl: "sonic.png",
            achievements: [
                { id: "1", name: "Ring Collector", description: "Get 100 rings", rarity: 30, iconUrl: "r.png", unlocked: true, unlockedAt: new Date("2026-03-04T05:06:07Z") },
                { id: "2", name: "Speedrun", description: "Fast", rarity: undefined, iconUrl: undefined, unlocked: false, unlockedAt: null },
            ],
        });
        expect(client.getGameProgress).toHaveBeenCalledWith("ra-user", "ra-key", "1446");
    });

    it("parses RA dates as UTC", () => {
        expect(parseRetroDate("2026-03-04 05:06:07").toISOString()).toBe("2026-03-04T05:06:07.000Z");
    });
});
