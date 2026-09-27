import { NextFunction, Request, Response } from "express";

// The server only listens on 127.0.0.1, but a web page can still reach it
// through DNS rebinding: a hostname that resolves to 127.0.0.1 makes the
// page same-origin with the app. Such a request still names that hostname in
// its Host header, so only answering requests addressed to this machine by
// the app's own port shuts that out (see #398).
export function isAllowedHost(host: string | undefined, port: number): boolean {
    // Every browser request carries a Host header; a bare client that
    // leaves it out isn't a rebinding page.
    if (host === undefined) return true;
    const normalized = host.toLowerCase();
    return normalized === `127.0.0.1:${port}` || normalized === `localhost:${port}`;
}

export function hostCheck(port: number) {
    return (req: Request, res: Response, next: NextFunction): void => {
        if (isAllowedHost(req.headers.host, port)) return next();
        res.status(403).json({ error: "Unrecognized host" });
    };
}
