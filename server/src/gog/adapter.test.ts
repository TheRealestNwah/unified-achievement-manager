import { beforeEach, describe, expect, it, vi } from "vitest";

// The GOG adapter with its client stubbed: no network, no database.
const client = vi.hoisted(() => ({
    exchangeRefreshTokenForTokens: vi.fn(),
    getOwnedGameIds: vi.fn(),
    getAchievementsForGame: vi.fn(),
    getProduct: vi.fn(),
}));
vi.mock("./client", () => client);

import { gogAdapter } from "./adapter";

const account = { id: "account", platformAccountId: "gog-user", accessToken: "old-access", refreshToken: "old-refresh", localFolder: null };

beforeEach(() => {
    vi.resetAllMocks();
    client.exchangeRefreshTokenForTokens.mockResolvedValue({ accessToken: "new-access", refreshToken: "new-refresh", expiresIn: 3600, userId: "gog-user" });
});

describe("GOG adapter", () => {
    it("refreshes tokens on connect and hands them back to be saved", async () => {
        const session = await gogAdapter.connect(account);
        expect(client.exchangeRefreshTokenForTokens).toHaveBeenCalledWith("old-refresh");
        expect(session.refreshedCredentials).toEqual({ accessToken: "new-access", refreshToken: "new-refresh" });

        client.getOwnedGameIds.mockResolvedValue(["1", "2"]);
        expect(await session.listOwnedGames()).toEqual([{ platformGameId: "1", details: undefined }, { platformGameId: "2", details: undefined }]);
        expect(client.getOwnedGameIds).toHaveBeenCalledWith("new-access");
    });

    it("reports no achievements without looking the product up", async () => {
        client.getAchievementsForGame.mockResolvedValue([]);
        const session = await gogAdapter.connect(account);
        expect(await session.fetchAchievementList({ platformGameId: "1", details: undefined })).toEqual({ kind: "none" });
        expect(client.getProduct).not.toHaveBeenCalled();
    });

    it("maps achievements, with the title and cover from the product", async () => {
        client.getAchievementsForGame.mockResolvedValue([
            { id: "a", key: "A", name: "First", description: "Do it", isUnlocked: true, unlockedAt: "2025-01-02T03:04:05Z", iconUrl: "https://icon/a" },
            { id: "b", key: "B", name: "Second", isUnlocked: false },
        ]);
        client.getProduct.mockResolvedValue({ title: "Some Game", coverImageUrl: "https://cover" });

        const session = await gogAdapter.connect(account);
        expect(await session.fetchAchievementList({ platformGameId: "1", details: undefined })).toEqual({
            kind: "achievements",
            title: "Some Game",
            coverImageUrl: "https://cover",
            achievements: [
                { id: "a", name: "First", description: "Do it", iconUrl: "https://icon/a", unlocked: true, unlockedAt: new Date("2025-01-02T03:04:05Z") },
                { id: "b", name: "Second", description: undefined, iconUrl: undefined, unlocked: false, unlockedAt: null },
            ],
        });
        expect(client.getAchievementsForGame).toHaveBeenCalledWith("new-access", "1", "gog-user");
    });
});
