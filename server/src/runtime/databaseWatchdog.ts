// The bundled PostgreSQL can still go away while the app runs - ended from
// Task Manager, or crashing - and every request after that just fails with
// ECONNREFUSED (see #415). This notices after a few failed checks in a row
// so the app can say so instead of carrying on as if nothing's wrong.

export interface DatabaseWatchdogOptions {
    check(): Promise<unknown>;
    onLost(err: unknown): void;
    intervalMs?: number;
    failuresBeforeLost?: number;
}

export function watchDatabase({ check, onLost, intervalMs = 5_000, failuresBeforeLost = 3 }: DatabaseWatchdogOptions): () => void {
    let failures = 0;
    let checking = false;
    let stopped = false;

    const stop = () => {
        stopped = true;
        clearInterval(timer);
    };

    const tick = async () => {
        // A check that hangs rather than failing shouldn't pile up behind itself.
        if (checking || stopped) return;
        checking = true;
        try {
            await check();
            failures = 0;
        } catch (err) {
            failures++;
            if (failures >= failuresBeforeLost && !stopped) {
                stop();
                onLost(err);
            }
        } finally {
            checking = false;
        }
    };

    const timer = setInterval(() => void tick(), intervalMs);
    timer.unref();
    return stop;
}
