import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
vi.mock("../db", () => ({ pool: { query: (...args: unknown[]) => queryMock(...args) } }));

beforeEach(() => {
    queryMock.mockReset();
});

describe("sync interval setting (#289)", () => {
    it("falls back to the default until one is saved, and reads off/minutes", async () => {
        const { getSyncIntervalMinutes } = await import("./syncInterval");
        queryMock.mockResolvedValueOnce({ rows: [] });
        await expect(getSyncIntervalMinutes(360)).resolves.toBe(360);
        queryMock.mockResolvedValueOnce({ rows: [{ value: "off" }] });
        await expect(getSyncIntervalMinutes(360)).resolves.toBeNull();
        queryMock.mockResolvedValueOnce({ rows: [{ value: "60" }] });
        await expect(getSyncIntervalMinutes(360)).resolves.toBe(60);
    });

    it("stores off as the string 'off'", async () => {
        const { setSyncIntervalMinutes } = await import("./syncInterval");
        queryMock.mockResolvedValueOnce({ rows: [] });
        await setSyncIntervalMinutes(null);
        expect(queryMock.mock.calls[0][1]).toEqual(["sync_interval_minutes", "off"]);
    });

    it("only accepts the offered choices", async () => {
        const { isValidSyncInterval } = await import("./syncInterval");
        expect(isValidSyncInterval(null)).toBe(true);
        expect(isValidSyncInterval(180)).toBe(true);
        expect(isValidSyncInterval(5)).toBe(false);
        expect(isValidSyncInterval("60")).toBe(false);
    });
});
