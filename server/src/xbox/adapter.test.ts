import { beforeEach, describe, expect, it, vi } from "vitest";

// The Xbox adapter with OpenXBL stubbed: no network, no database.
const client = vi.hoisted(() => ({
    getTitles: vi.fn(),
    getAchievementsForTitle: vi.fn(),
    getX360AchievementsForTitle: vi.fn(),
}));
vi.mock("./client", () => client);

import { xboxAdapter } from "./adapter";

const account = { id: "account", platformAccountId: "xuid", accessToken: "api-key", refreshToken: null, localFolder: null };

const achievement = {
    id: "a1",
    name: "First Steps",
    description: "Do the thing",
    isUnlocked: true,
    timeUnlocked: "2026-09-01T10:00:00Z",
    gamerscore: 10,
    rarityPercent: 12.5,
};

beforeEach(() => {
    vi.resetAllMocks();
    client.getTitles.mockResolvedValue([
        { titleId: "100", name: "Halo", totalAchievements: 5, coverImageUrl: "halo.jpg", progress: "5|1|10|t1" },
        { titleId: "200", name: "No Progress", totalAchievements: 3 },
        { titleId: "300", name: "An App", totalAchievements: 0, progress: "0|0|0|t1" },
    ]);
});

async function connect() {
    const session = await xboxAdapter.connect(account);
    const owned = await session.listOwnedGames();
    return { session, owned };
}

describe("Xbox adapter", () => {
    it("marks titles by progress and flags ones with no achievements (#384)", async () => {
        const { owned } = await connect();
        expect(owned).toEqual([
            { platformGameId: "100", changeMarker: "5|1|10|t1", hasAchievements: true },
            // No progress summary, so no marker: always fetched.
            { platformGameId: "200", changeMarker: undefined, hasAchievements: true },
            { platformGameId: "300", changeMarker: "0|0|0|t1", hasAchievements: false },
        ]);
        expect(client.getTitles).toHaveBeenCalledWith("api-key");
    });

    it("maps a modern title's achievements with no console label", async () => {
        client.getAchievementsForTitle.mockResolvedValue([achievement]);
        const { session } = await connect();
        expect(await session.fetchAchievementList({ platformGameId: "100" })).toEqual({
            kind: "achievements",
            title: "Halo",
            coverImageUrl: "halo.jpg",
            consoleVariant: undefined,
            achievements: [
                { id: "a1", name: "First Steps", description: "Do the thing", rarity: 12.5, iconUrl: undefined, unlocked: true, unlockedAt: new Date("2026-09-01T10:00:00Z") },
            ],
        });
        expect(client.getX360AchievementsForTitle).not.toHaveBeenCalled();
    });

    it("falls back to the legacy endpoint and labels the title Xbox 360 (#36)", async () => {
        client.getAchievementsForTitle.mockResolvedValue([]);
        client.getX360AchievementsForTitle.mockResolvedValue([{ ...achievement, isUnlocked: false, timeUnlocked: undefined }]);
        const { session } = await connect();
        const result = await session.fetchAchievementList({ platformGameId: "100" });
        expect(client.getX360AchievementsForTitle).toHaveBeenCalledWith("api-key", "xuid", "100");
        expect(result).toMatchObject({ kind: "achievements", consoleVariant: "Xbox 360", achievements: [{ unlocked: false, unlockedAt: null }] });
    });

    it("reports no achievements when neither endpoint has any", async () => {
        client.getAchievementsForTitle.mockResolvedValue([]);
        client.getX360AchievementsForTitle.mockResolvedValue([]);
        const { session } = await connect();
        expect(await session.fetchAchievementList({ platformGameId: "100" })).toEqual({ kind: "none" });
    });
});
