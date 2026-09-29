import { describe, expect, it } from "vitest";
import { oneAtATime } from "./oneAtATime";

function deferred() {
    let resolve!: () => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

describe("oneAtATime (#422)", () => {
    it("never runs the task twice at once, and calls during a run share the next one", async () => {
        const runs: ReturnType<typeof deferred>[] = [];
        let active = 0;
        let maxActive = 0;
        const run = oneAtATime(async () => {
            const d = deferred();
            runs.push(d);
            active++;
            maxActive = Math.max(maxActive, active);
            try {
                await d.promise;
                return runs.length;
            } finally {
                active--;
            }
        });

        const first = run();
        const second = run();
        const third = run();
        expect(runs).toHaveLength(1);

        runs[0].resolve();
        expect(await first).toBe(1);
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 0));
        expect(runs).toHaveLength(2);

        runs[1].resolve();
        expect(await second).toBe(2);
        expect(await third).toBe(2);
        expect(maxActive).toBe(1);
    });

    it("still runs the waiting call after the current run fails", async () => {
        const runs: ReturnType<typeof deferred>[] = [];
        const run = oneAtATime(async () => {
            const d = deferred();
            runs.push(d);
            await d.promise;
            return "ok";
        });

        const failing = run();
        const waiting = run();
        runs[0].reject(new Error("foreign key violation"));
        await expect(failing).rejects.toThrow("foreign key violation");
        await new Promise((r) => setTimeout(r, 0));
        runs[1].resolve();
        expect(await waiting).toBe("ok");
    });

    it("starts straight away when nothing is running", async () => {
        let calls = 0;
        const run = oneAtATime(async () => ++calls);
        expect(await run()).toBe(1);
        expect(await run()).toBe(2);
    });
});
