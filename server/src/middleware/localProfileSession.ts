import { Request, Response, NextFunction } from "express";
import { getLocalProfile } from "../auth/localProfile";

// Signs a session-less request in as the local profile (see #393), so every
// route behind requireAuth works without a sign-in page. Only safe because
// the server listens on 127.0.0.1 and requireLocalHost turns away anything
// addressed to another host name.
export async function signInLocalProfile(req: Request, _res: Response, next: NextFunction) {
    if (req.isAuthenticated()) return next();
    try {
        const profile = await getLocalProfile();
        if (!profile) return next();
        req.login(profile, next);
    } catch (err) {
        next(err);
    }
}

// Listening on 127.0.0.1 keeps other machines out, but not a web page in the
// user's own browser that points its own domain at 127.0.0.1 (DNS rebinding):
// the browser would treat it as that site's own origin and, with nobody
// having to sign in, hand it the whole app. Such a request still names the
// attacker's host, so only the app's own host names are served.
export function requireLocalHost(port: number) {
    const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    return (req: Request, res: Response, next: NextFunction) => {
        if (allowed.has((req.headers.host ?? "").toLowerCase())) return next();
        res.status(421).json({ error: "This server only answers requests addressed to 127.0.0.1." });
    };
}
