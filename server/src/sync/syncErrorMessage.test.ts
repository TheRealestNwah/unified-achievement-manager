import { describe, expect, it } from "vitest";
import { explainSyncError } from "./syncErrorMessage";

describe("explainSyncError (#389)", () => {
    it("explains an OpenXBL rate limit as temporary, keeping the raw error as detail", () => {
        const raw = "OpenXBL /v2/achievements failed: 429";
        const explained = explainSyncError("xbox", raw);
        expect(explained.message).toMatch(/limiting requests from your API key/);
        expect(explained.message).toMatch(/picks up where this one stopped/);
        expect(explained).toMatchObject({ detail: raw, actionable: false });
    });

    it("names the platform for other platforms' rate limits", () => {
        expect(explainSyncError("psn", "PSN API /trophies failed: 429").message).toMatch(/^PlayStation Network is limiting/);
    });

    it("sends a rejected credential to Settings", () => {
        expect(explainSyncError("retroachievements", "RetroAchievements API /x failed: 401")).toMatchObject({
            message: "RetroAchievements didn't accept the saved login or API key. Reconnect RetroAchievements in Settings.",
            actionable: true,
        });
    });

    it("treats server errors and dropped connections as temporary", () => {
        expect(explainSyncError("steam", "Steam API /x failed: 503 Service Unavailable")).toMatchObject({ actionable: false });
        expect(explainSyncError("steam", "Steam API /x failed: 503 Service Unavailable").message).toMatch(/error 503/);
        expect(explainSyncError("gog", "getaddrinfo ENOTFOUND api.gog.com")).toMatchObject({ actionable: false });
        expect(explainSyncError("gog", "getaddrinfo ENOTFOUND api.gog.com").message).toMatch(/^Couldn't reach GOG/);
    });

    it("says a refused refresh token means the login expired (#424)", () => {
        expect(explainSyncError("psn", "PlayStation Network login expired (token refresh refused with 400)")).toMatchObject({
            message: "Your PlayStation Network login has expired. Use Update login… in Settings to reconnect.",
            actionable: true,
        });
        expect(explainSyncError("gog", "GOG login expired (token refresh refused)").message).toBe(
            "Your GOG login has expired. Use Update login… in Settings to reconnect."
        );
    });

    it("leaves errors it doesn't recognise as they are", () => {
        expect(explainSyncError("xbox", "Invalid OpenXBL API key")).toEqual({ message: "Invalid OpenXBL API key", detail: null, actionable: true });
        // A status-looking number that isn't an HTTP failure isn't read as one.
        expect(explainSyncError("psn", "Something failed: 4290 times").detail).toBeNull();
    });
});
