import { ErrorRequestHandler } from "express";
import { DatabaseError } from "pg";

// PostgreSQL's invalid_text_representation, e.g. a non-UUID game ID from
// the URL hitting a uuid column (see #336).
const PG_INVALID_TEXT_REPRESENTATION = "22P02";

export function errorResponse(err: unknown): { status: number; error: string } {
    if (err instanceof DatabaseError) {
        // Never echo the database's own message: it's internal detail, and a
        // malformed ID is the caller's mistake, not a server failure.
        if (err.code === PG_INVALID_TEXT_REPRESENTATION) return { status: 400, error: "Invalid ID" };
        return { status: 500, error: "Internal server error" };
    }
    // express.json()'s parse errors and similar carry their own 4xx status.
    const status = (err as { status?: unknown } | null)?.status;
    if (typeof status === "number" && status >= 400 && status < 500) {
        return { status, error: err instanceof Error ? err.message : "Bad request" };
    }
    return { status: 500, error: err instanceof Error ? err.message : "Internal server error" };
}

// Every route hands failures to next(err); without this, Express's default
// handler sends an HTML error page, which breaks every fetch()-based call in
// the dashboard (JSON.parse on "<!DOCTYPE ...").
export const jsonErrorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    const { status, error } = errorResponse(err);
    if (status >= 500) console.error(err);
    res.status(status).json({ error });
};
