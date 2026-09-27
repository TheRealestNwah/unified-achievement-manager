import { EventEmitter } from "events";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The client talks to OpenXBL through https.get (not fetch - see client.ts),
// so the fake sits at that layer: each queued response answers the next call.
const { responses, requestedPaths } = vi.hoisted(() => ({
    responses: [] as Array<{ status: number; body: unknown; headers?: Record<string, string> }>,
    requestedPaths: [] as string[],
}));

vi.mock("https", () => {
    const get = (url: string, _options: unknown, callback: (res: EventEmitter) => void) => {
        requestedPaths.push(url.replace("https://api.xbl.io", ""));
        const next = responses.shift();
        if (!next) throw new Error(`Unexpected OpenXBL request: ${url}`);
        const res = Object.assign(new EventEmitter(), { statusCode: next.status, headers: next.headers ?? {} });
        setImmediate(() => {
            res.emit("data", typeof next.body === "string" ? next.body : JSON.stringify(next.body));
            res.emit("end");
        });
        callback(res);
        return { on: () => undefined };
    };
    return { default: { get }, get };
});

import { getAccount, getAchievementsForTitle, getTitleIdForProduct, getTitles, getX360AchievementsForTitle, XboxApiError } from "./client";

function respond(content: unknown, { status = 200, code = 200, headers }: { status?: number; code?: number; headers?: Record<string, string> } = {}) {
    responses.push({ status, body: { content, code }, headers });
}

beforeEach(() => {
    responses.length = 0;
    requestedPaths.length = 0;
});

describe("Xbox (OpenXBL) client response parsing", () => {
    it("reads gamertag and gamerscore out of the profile settings list", async () => {
        respond({
            profileUsers: [
                {
                    id: "2533274800000000",
                    settings: [
                        { id: "Gamertag", value: "Player One" },
                        { id: "Gamerscore", value: "12345" },
                    ],
                },
            ],
        });
        await expect(getAccount("key")).resolves.toEqual({ xuid: "2533274800000000", gamertag: "Player One", gamerscore: 12345 });
    });

    it("rejects an HTTP 200 whose body carries a non-200 OpenXBL code", async () => {
        respond(null, { code: 400 });
        const err = await getAccount("key").catch((e) => e);
        expect(err).toBeInstanceOf(XboxApiError);
        expect(err.status).toBe(400);
    });

    it("maps an HTTP 401 to an invalid-key error", async () => {
        responses.push({ status: 401, body: "" });
        await expect(getAccount("bad")).rejects.toMatchObject({ status: 401, message: "Invalid OpenXBL API key" });
    });

    it("retries a 429 after the Retry-After delay", async () => {
        responses.push({ status: 429, body: "", headers: { "retry-after": "0" } });
        respond({ profileUsers: [{ id: "1", settings: [] }] });
        await expect(getAccount("key")).resolves.toMatchObject({ xuid: "1", gamertag: "", gamerscore: 0 });
        expect(requestedPaths).toEqual(["/v2/account", "/v2/account"]);
    });

    it("maps modern achievements and follows the continuation token across pages", async () => {
        respond({
            achievements: [
                {
                    id: "1",
                    name: "First",
                    description: "d",
                    progressState: "Achieved",
                    progression: { timeUnlocked: "2023-05-01T00:00:00Z" },
                    rewards: [{ type: "Art", value: "x" }, { type: "Gamerscore", value: "15" }],
                    rarity: { currentPercentage: 42.1 },
                    mediaAssets: [{ type: "Background", url: "https://bg.test" }, { type: "Icon", url: "https://icon.test" }],
                },
            ],
            pagingInfo: { continuationToken: "32" },
        });
        respond({
            achievements: [{ id: "2", name: "Second", description: "d", progressState: "NotStarted" }],
            pagingInfo: { continuationToken: null },
        });

        const achievements = await getAchievementsForTitle("key", "1234");
        expect(requestedPaths).toEqual(["/v2/achievements/title/1234", "/v2/achievements/title/1234?continuationToken=32"]);
        expect(achievements).toEqual([
            {
                id: "1",
                name: "First",
                description: "d",
                isUnlocked: true,
                timeUnlocked: "2023-05-01T00:00:00Z",
                gamerscore: 15,
                rarityPercent: 42.1,
                iconUrl: "https://icon.test",
            },
            {
                id: "2",
                name: "Second",
                description: "d",
                isUnlocked: false,
                timeUnlocked: undefined,
                gamerscore: 0,
                rarityPercent: undefined,
                iconUrl: undefined,
            },
        ]);
    });

    it("merges Xbox 360 definitions with the earned-only list and ignores the definitions' placeholder status", async () => {
        const definitions = {
            achievements: [
                // The definitions endpoint's own unlock fields are placeholders.
                { id: 1, name: "Earned", description: "a", unlocked: false, timeUnlocked: "2002-01-01T00:00:00Z", gamerscore: 10, rarity: { currentPercentage: 60 } },
                { id: 2, name: "Sentinel date", description: "b", unlocked: false, timeUnlocked: "2002-01-01T00:00:00Z", gamerscore: 20 },
                { id: 3, name: "Not earned", description: "c", unlocked: false, timeUnlocked: "2002-01-01T00:00:00Z", gamerscore: 30, rarity: { currentPercentage: 5 } },
            ],
        };
        const earned = {
            achievements: [
                { id: 1, name: "Earned", description: "a", unlocked: true, timeUnlocked: "2008-06-01T10:00:00Z", gamerscore: 10, rarity: { currentPercentage: 55 } },
                { id: 2, name: "Sentinel date", description: "b", unlocked: true, timeUnlocked: "1752-12-31T00:00:00Z", gamerscore: 20 },
            ],
        };
        // Promise.all issues both requests before either resolves: definitions first, earned second.
        respond(definitions);
        respond(earned);

        const achievements = await getX360AchievementsForTitle("key", "xuid", "4d5307e6");
        expect(requestedPaths).toEqual(["/v2/achievements/player/xuid/title/4d5307e6", "/v2/achievements/x360/xuid/title/4d5307e6"]);
        expect(achievements).toEqual([
            { id: "1", name: "Earned", description: "a", isUnlocked: true, timeUnlocked: "2008-06-01T10:00:00Z", gamerscore: 10, rarityPercent: 55, iconUrl: undefined },
            { id: "2", name: "Sentinel date", description: "b", isUnlocked: true, timeUnlocked: undefined, gamerscore: 20, rarityPercent: undefined, iconUrl: undefined },
            { id: "3", name: "Not earned", description: "c", isUnlocked: false, timeUnlocked: undefined, gamerscore: 30, rarityPercent: 5, iconUrl: undefined },
        ]);
    });

    // mediaAssets, if the definitions endpoint ever sends it, wins over the
    // URL built from imageId (see #165 below).
    it("reads the icon out of the Xbox 360 definitions endpoint's mediaAssets", async () => {
        const definitions = {
            achievements: [
                {
                    id: 1,
                    name: "Earned",
                    description: "a",
                    unlocked: false,
                    timeUnlocked: "2002-01-01T00:00:00Z",
                    gamerscore: 10,
                    mediaAssets: [{ type: "Background", url: "https://bg.test" }, { type: "Icon", url: "https://icon.test/x360.png" }],
                },
            ],
        };
        const earned = {
            achievements: [{ id: 1, name: "Earned", description: "a", unlocked: true, timeUnlocked: "2008-06-01T10:00:00Z", gamerscore: 10 }],
        };
        respond(definitions);
        respond(earned);

        const [achievement] = await getX360AchievementsForTitle("key", "xuid", "4d5307e6");
        expect(achievement).toMatchObject({ id: "1", isUnlocked: true, iconUrl: "https://icon.test/x360.png" });
    });

    // Regression test for #165: the real definitions endpoint has no
    // mediaAssets, only an imageId, so the icon has to be built from it.
    it("builds the Xbox 360 icon URL from the title id and image id", async () => {
        respond({
            achievements: [
                { id: 1, titleId: 1112737745, imageId: 1, name: "Escaped the Imperial Sewers", description: "a", unlocked: false, gamerscore: 50 },
                { id: 64, titleId: 1297287449, imageId: 139, name: "Dawn", description: "b", unlocked: false, gamerscore: 10 },
            ],
        });
        respond({ achievements: [] });

        const achievements = await getX360AchievementsForTitle("key", "xuid", "1112737745");
        expect(achievements.map((a) => a.iconUrl)).toEqual([
            "https://image-ssl.xboxlive.com/global/t.425307d1/ach/0/1",
            "https://image-ssl.xboxlive.com/global/t.4d530919/ach/0/8b",
        ]);
    });

    it("treats a Store product with no Xbox title id (404) as no match", async () => {
        responses.push({ status: 404, body: "" });
        await expect(getTitleIdForProduct("key", "9NBLGGH4R315")).resolves.toBeUndefined();
    });

    it("still surfaces other title-id lookup failures", async () => {
        responses.push({ status: 500, body: "" });
        await expect(getTitleIdForProduct("key", "9NBLGGH4R315")).rejects.toMatchObject({ status: 500 });
    });

    it("fingerprints each title's progress from the title list (#384)", async () => {
        respond({
            titles: [
                {
                    titleId: "1",
                    name: "Played",
                    achievement: { totalAchievements: 50, currentAchievements: 12, currentGamerscore: 240 },
                    titleHistory: { lastTimePlayed: "2026-09-01T10:00:00Z" },
                },
                { titleId: "2", name: "No progress fields", achievement: { totalAchievements: 20 } },
            ],
        });
        const titles = await getTitles("key");
        expect(titles[0].progress).toBe("50|12|240|2026-09-01T10:00:00Z");
        // Nothing to compare, so sync has to fetch it every time.
        expect(titles[1].progress).toBeUndefined();
    });
});
