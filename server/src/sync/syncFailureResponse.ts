import { NextFunction, Response } from "express";
import { explainSyncError } from "./syncErrorMessage";

// Answers a failed on-demand sync with the same plain-language message
// Settings shows for the stored error afterwards (see #389, #424), so a
// failure doesn't read differently before and after a reload. Errors it has
// no explanation for go to the normal error handler.
export function sendSyncFailure(platformId: string, err: unknown, res: Response, next: NextFunction): void {
    const explained = explainSyncError(platformId, err instanceof Error ? err.message : String(err));
    if (explained.detail === null) return next(err);
    res.status(502).json({ error: explained.message });
}
