import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchDatabase } from "./databaseWatchdog";

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

const refused = () => Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });

describe("watchDatabase", () => {
    it("reports the database lost after enough failed checks in a row (#415)", async () => {
        const onLost = vi.fn();
        const err = refused();
        watchDatabase({ check: () => Promise.reject(err), onLost, intervalMs: 1000, failuresBeforeLost: 3 });

        await vi.advanceTimersByTimeAsync(2000);
        expect(onLost).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1000);
        expect(onLost).toHaveBeenCalledOnce();
        expect(onLost).toHaveBeenCalledWith(err);

        // And only once: it stops checking after that.
        await vi.advanceTimersByTimeAsync(10_000);
        expect(onLost).toHaveBeenCalledOnce();
    });

    it("starts counting again after a check succeeds", async () => {
        const onLost = vi.fn();
        const results = [false, false, true, false, false, true];
        const check = vi.fn(() => (results.shift() ?? true ? Promise.resolve() : Promise.reject(refused())));
        watchDatabase({ check, onLost, intervalMs: 1000, failuresBeforeLost: 3 });

        await vi.advanceTimersByTimeAsync(10_000);
        expect(check).toHaveBeenCalledTimes(10);
        expect(onLost).not.toHaveBeenCalled();
    });

    it("doesn't start another check while one is still running", async () => {
        const check = vi.fn(() => new Promise(() => undefined));
        watchDatabase({ check, onLost: vi.fn(), intervalMs: 1000 });

        await vi.advanceTimersByTimeAsync(5000);
        expect(check).toHaveBeenCalledOnce();
    });

    it("stops checking once stopped", async () => {
        const check = vi.fn(() => Promise.reject(refused()));
        const onLost = vi.fn();
        const stop = watchDatabase({ check, onLost, intervalMs: 1000 });

        await vi.advanceTimersByTimeAsync(1000);
        stop();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(check).toHaveBeenCalledOnce();
        expect(onLost).not.toHaveBeenCalled();
    });
});
