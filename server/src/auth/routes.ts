import { Router } from "express";
import { passport, SteamIdentity } from "./passport";
import { getCsrfToken } from "../middleware/csrf";
import { requireAuth } from "../middleware/requireAuth";
import { hasSteamApiKey } from "../settings/steamApiKey";
import { linkSteamAccount, SteamLinkError } from "./steamLink";

export const authRouter = Router();

// Connecting Steam (see #393): Steam's OpenID page proves which Steam account
// is the user's, and it's linked to the local profile. There's no strategy
// until a Steam Web API key exists, so without one, go back to the dashboard.
authRouter.use("/steam", requireAuth, (_req, res, next) => (hasSteamApiKey() ? next() : res.redirect("/")));

authRouter.get("/steam", passport.authorize("steam"));

authRouter.get("/steam/return", passport.authorize("steam", { failureRedirect: "/?steam=failed" }), async (req, res, next) => {
    try {
        // passport.authorize puts the Steam identity here, off the session.
        const identity = (req as typeof req & { account: SteamIdentity }).account;
        await linkSteamAccount(req.user!.id, identity);
        res.redirect("/");
    } catch (err) {
        if (err instanceof SteamLinkError) return res.redirect(`/?steam=${encodeURIComponent(err.message)}`);
        next(err);
    }
});

authRouter.get("/me", requireAuth, (req, res) => {
    res.json(req.user);
});

authRouter.get("/csrf-token", requireAuth, (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ token: getCsrfToken(req) });
});
