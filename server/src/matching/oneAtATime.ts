// Runs a task one call at a time (see #422). A call made while a run is under
// way waits for it and then gets a fresh run, since it may have new data to
// work on; every call that arrives during that wait shares the same next run
// rather than queueing one each.
export function oneAtATime<T>(task: () => Promise<T>): () => Promise<T> {
    let running: Promise<T> | null = null;
    let next: Promise<T> | null = null;

    const start = (): Promise<T> => {
        const run = task().finally(() => {
            if (running === run) running = null;
        });
        running = run;
        return run;
    };

    return () => {
        if (next) return next;
        if (!running) return start();
        next = running
            .catch(() => undefined)
            .then(() => {
                next = null;
                return start();
            });
        return next;
    };
}
