import { beforeEach, describe, expect, it, vi } from "vitest";

// Only the in-flight bookkeeping is under test here (see #323); the sync
// pipeline and the database are stubs.
const runSyncPipeline = vi.fn();
vi.mock("./pipeline", () => ({ runSyncPipeline: (...args: unknown[]) => runSyncPipeline(...args) }));
vi.mock("./adapters", () => ({ platformAdapters: { steam: { platformId: "steam" } } }));
vi.mock("../db", () => ({ pool: { query: vi.fn().mockResolvedValue({ rows: [] }) } }));
vi.mock("../config", () => ({ config: { credentialEncryptionKey: "unused" } }));

import { runAccountSync, syncingAccountIds, PlatformAccountRow } from "./runAccountSync";

const account = (id: string): PlatformAccountRow => ({
    id,
    user_id: "user",
    platform_id: "steam",
    platform_account_id: `steam-${id}`,
    access_token: null,
    refresh_token: null,
});

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (err: unknown) => void;
    const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
    return { promise, resolve, reject };
}

beforeEach(() => {
    runSyncPipeline.mockReset();
});

describe("runAccountSync one-sync-per-account (#323)", () => {
    it("joins a sync already running for the same account instead of starting another", async () => {
        const pending = deferred<{ gamesProcessed: number; achievementsUnlocked: number }>();
        runSyncPipeline.mockReturnValueOnce(pending.promise);

        const first = runAccountSync(account("a"));
        const second = runAccountSync(account("a"));
        expect(syncingAccountIds()).toEqual(new Set(["a"]));

        pending.resolve({ gamesProcessed: 3, achievementsUnlocked: 1 });
        await expect(first).resolves.toEqual({ gamesProcessed: 3, achievementsUnlocked: 1 });
        await expect(second).resolves.toEqual({ gamesProcessed: 3, achievementsUnlocked: 1 });
        expect(runSyncPipeline).toHaveBeenCalledTimes(1);
        expect(syncingAccountIds().size).toBe(0);
    });

    it("runs different accounts side by side", async () => {
        runSyncPipeline.mockResolvedValue({ gamesProcessed: 0, achievementsUnlocked: 0 });
        await Promise.all([runAccountSync(account("a")), runAccountSync(account("b"))]);
        expect(runSyncPipeline).toHaveBeenCalledTimes(2);
    });

    it("clears the account after a failure so the next sync starts fresh", async () => {
        runSyncPipeline.mockRejectedValueOnce(new Error("Steam said no"));
        await expect(runAccountSync(account("a"))).rejects.toThrow("Steam said no");
        expect(syncingAccountIds().size).toBe(0);

        runSyncPipeline.mockResolvedValueOnce({ gamesProcessed: 1, achievementsUnlocked: 0 });
        await expect(runAccountSync(account("a"))).resolves.toEqual({ gamesProcessed: 1, achievementsUnlocked: 0 });
    });
});

describe("runAccountSync platform lookup", () => {
    it("throws for a platform with no adapter, without running the pipeline", async () => {
        await expect(runAccountSync({ ...account("x"), platform_id: "atari" })).rejects.toThrow(
            "No platform adapter for platform: atari",
        );
        expect(runSyncPipeline).not.toHaveBeenCalled();
        expect(syncingAccountIds().size).toBe(0);
    });
});
