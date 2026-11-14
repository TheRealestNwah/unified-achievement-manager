import { beforeEach, describe, expect, it, vi } from "vitest";

// The PSN adapter with its client stubbed: no network, no database.
const client = vi.hoisted(() => ({
    exchangeRefreshTokenForTokens: vi.fn(),
    getUserTitles: vi.fn(),
    getTitleTrophies: vi.fn(),
    getUserTrophiesEarnedForTitle: vi.fn(),
}));
vi.mock("./client", () => client);

import { psnAdapter } from "./adapter";

const account = { platformAccountId: "psn-user", accessToken: "old-access", refreshToken: "old-refresh", localFolder: null };

beforeEach(() => {
    vi.resetAllMocks();
    client.exchangeRefreshTokenForTokens.mockResolvedValue({ accessToken: "new-access", refreshToken: "new-refresh", expiresIn: 3600, idToken: "id" });
    client.getUserTitles.mockResolvedValue([
        { npCommunicationId: "NPWR1", npServiceName: "trophy", trophyTitleName: "Uncharted", trophyTitleIconUrl: "u.png", trophyTitlePlatform: "PS3" },
    ]);
});

async function connect() {
    const session = await psnAdapter.connect(account);
    const owned = await session.listOwnedGames();
    return { session, owned };
}

describe("PSN adapter", () => {
    it("refreshes tokens on connect and hands them back to be saved", async () => {
        const { session, owned } = await connect();
        expect(client.exchangeRefreshTokenForTokens).toHaveBeenCalledWith("old-refresh");
        expect(session.refreshedCredentials).toEqual({ accessToken: "new-access", refreshToken: "new-refresh" });
        expect(owned).toEqual([{ platformGameId: "NPWR1", details: expect.objectContaining({ trophyTitleName: "Uncharted" }) }]);
        expect(client.getUserTitles).toHaveBeenCalledWith("new-access");
    });

    it("reports no achievements for an empty trophy list", async () => {
        client.getTitleTrophies.mockResolvedValue([]);
        client.getUserTrophiesEarnedForTitle.mockResolvedValue([]);
        const { session, owned } = await connect();
        expect(await session.fetchAchievementList(owned[0])).toEqual({ kind: "none" });
    });

    it("maps trophies with their native tier, rarity and earned dates", async () => {
        client.getTitleTrophies.mockResolvedValue([
            { trophyId: 0, trophyType: "platinum", trophyName: "All Done", trophyDetail: "Everything", trophyHidden: false, trophyIconUrl: "p.png" },
            { trophyId: 1, trophyType: "bronze", trophyHidden: true },
        ]);
        client.getUserTrophiesEarnedForTitle.mockResolvedValue([
            { trophyId: 0, earned: true, earnedDateTime: "2026-01-02T03:04:05Z", trophyEarnedRate: "4.5" },
            { trophyId: 1, earned: false, trophyEarnedRate: "60.0" },
        ]);
        const { session, owned } = await connect();

        expect(await session.fetchAchievementList(owned[0])).toEqual({
            kind: "achievements",
            title: "Uncharted",
            coverImageUrl: "u.png",
            consoleVariant: "PS3",
            achievements: [
                {
                    id: "0",
                    name: "All Done",
                    description: "Everything",
                    rarity: 4.5,
                    nativeTier: { tier: "platinum", tierSource: "psn_native" },
                    iconUrl: "p.png",
                    unlocked: true,
                    unlockedAt: new Date("2026-01-02T03:04:05Z"),
                },
                {
                    id: "1",
                    name: "Hidden trophy",
                    description: undefined,
                    rarity: 60,
                    nativeTier: { tier: "bronze", tierSource: "psn_native" },
                    iconUrl: undefined,
                    unlocked: false,
                    unlockedAt: null,
                },
            ],
        });
        expect(client.getTitleTrophies).toHaveBeenCalledWith("new-access", "NPWR1", "trophy");
    });
});
