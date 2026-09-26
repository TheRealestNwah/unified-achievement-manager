import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
vi.mock("../db", () => ({ pool: { query: (...args: unknown[]) => queryMock(...args) } }));

beforeEach(() => {
    queryMock.mockReset();
});

describe("getDesktopSettings", () => {
    it("defaults everything to off when nothing has been saved (see #249)", async () => {
        const { getDesktopSettings } = await import("./desktopSettings");
        queryMock.mockResolvedValueOnce({ rows: [] });
        await expect(getDesktopSettings()).resolves.toEqual({ keepInTray: false, startWithWindows: false, unlockNotifications: true });
    });

    it("reflects saved rows", async () => {
        const { getDesktopSettings } = await import("./desktopSettings");
        queryMock.mockResolvedValueOnce({ rows: [{ key: "desktop_keep_in_tray", value: "true" }] });
        await expect(getDesktopSettings()).resolves.toEqual({ keepInTray: true, startWithWindows: false, unlockNotifications: true });
    });
});

describe("updateDesktopSettings", () => {
    it("only writes the settings that were passed as booleans", async () => {
        const { updateDesktopSettings } = await import("./desktopSettings");
        queryMock.mockResolvedValue({ rows: [] });
        await updateDesktopSettings({ startWithWindows: true, keepInTray: "yes" as unknown as boolean });
        const writes = queryMock.mock.calls.filter(([sql]) => String(sql).startsWith("insert"));
        expect(writes).toHaveLength(1);
        expect(writes[0][1]).toEqual(["desktop_start_with_windows", "true"]);
    });
});
