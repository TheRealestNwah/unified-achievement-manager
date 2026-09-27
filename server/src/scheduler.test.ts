import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn(async () => ({ rows: [] }));
const getSyncIntervalMinutes = vi.fn();
vi.mock("./db", () => ({ pool: { query: () => queryMock() } }));
vi.mock("./settings/syncInterval", () => ({ getSyncIntervalMinutes: (fallback: number) => getSyncIntervalMinutes(fallback) }));
vi.mock("./sync/runAccountSync", () => ({ runAccountSync: vi.fn() }));
vi.mock("./scoring", () => ({ recomputeUserScore: vi.fn() }));
vi.mock("./matching", () => ({ runMatching: vi.fn() }));

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-27T12:00:00Z"));
    queryMock.mockClear();
    getSyncIntervalMinutes.mockReset();
});

afterEach(() => {
    vi.useRealTimers();
});

describe("scheduler interval (#289)", () => {
    it("uses the saved interval, reschedules on change, and stops when set to off", async () => {
        const { startScheduler, applySchedulerInterval, getSchedulerStatus } = await import("./scheduler");
        getSyncIntervalMinutes.mockResolvedValue(60);
        const stop = startScheduler(360);
        // Let startScheduler's async setup finish without moving the fake clock.
        for (let i = 0; i < 10; i++) await Promise.resolve();
        expect(getSchedulerStatus().intervalMinutes).toBe(60);
        expect(getSyncIntervalMinutes).toHaveBeenCalledWith(360);
        expect(getSchedulerStatus().nextRunAt?.toISOString()).toBe("2026-09-27T13:00:00.000Z");
        // Startup syncs straight away (one accounts query).
        expect(queryMock).toHaveBeenCalledTimes(1);

        getSyncIntervalMinutes.mockResolvedValue(720);
        await applySchedulerInterval();
        expect(getSchedulerStatus().intervalMinutes).toBe(720);
        expect(getSchedulerStatus().nextRunAt?.toISOString()).toBe("2026-09-28T00:00:00.000Z");
        // Changing the interval doesn't trigger an extra sync.
        expect(queryMock).toHaveBeenCalledTimes(1);

        getSyncIntervalMinutes.mockResolvedValue(null);
        await applySchedulerInterval();
        expect(getSchedulerStatus()).toMatchObject({ intervalMinutes: null, nextRunAt: null });
        await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
        expect(queryMock).toHaveBeenCalledTimes(1);

        stop();
        expect(getSchedulerStatus().enabled).toBe(false);
    });
});
