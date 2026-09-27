import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn(async () => ({ rows: [] }));
const getSyncIntervalMinutes = vi.fn();
vi.mock("./db", () => ({ pool: { query: () => queryMock() } }));
vi.mock("./settings/syncInterval", () => ({ getSyncIntervalMinutes: (fallback: number) => getSyncIntervalMinutes(fallback) }));
const runAccountSync = vi.fn();
vi.mock("./sync/runAccountSync", () => ({ runAccountSync: (...args: unknown[]) => runAccountSync(...args) }));
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

describe("scheduler shutdown (#408)", () => {
    it("stops a run in progress quietly instead of failing every remaining account", async () => {
        const { startScheduler } = await import("./scheduler");
        getSyncIntervalMinutes.mockResolvedValue(60);
        const account = (id: string) => ({ id, user_id: "u", platform_id: "steam" });
        queryMock.mockResolvedValueOnce({ rows: [account("a"), account("b"), account("c")] } as never);
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
        vi.spyOn(console, "log").mockImplementation(() => undefined);
        let stop: () => void = () => undefined;
        // The first account's sync is cut off by the app quitting mid-sync.
        runAccountSync.mockReset().mockImplementationOnce(async () => {
            stop();
            throw new Error("Cannot use a pool after calling end on the pool");
        });

        stop = startScheduler(360);
        for (let i = 0; i < 20; i++) await Promise.resolve();

        expect(runAccountSync).toHaveBeenCalledTimes(1);
        expect(consoleError).not.toHaveBeenCalled();
        vi.restoreAllMocks();
    });
});
