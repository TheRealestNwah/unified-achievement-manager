import { Router } from "express";
import { passport } from "./passport";
import { getCsrfToken } from "../middleware/csrf";
import { requireAuth } from "../middleware/requireAuth";
import { hasSteamApiKey } from "../settings/steamApiKey";

export const authRouter = Router();

// No strategy is registered until a Steam Web API key exists; send the user
// back to the dashboard's setup screen instead of a passport error.
authRouter.use("/steam", (_req, res, next) => (hasSteamApiKey() ? next() : res.redirect("/")));

authRouter.get("/steam", passport.authenticate("steam"));

authRouter.get(
    "/steam/return",
    passport.authenticate("steam", { failureRedirect: "/" }),
    (_req, res) => res.redirect("/")
);

authRouter.post("/logout", (req, res, next) => {
    req.logout((err) => {
        if (err) return next(err);
        res.status(204).end();
    });
});

authRouter.get("/me", requireAuth, (req, res) => {
    res.json(req.user);
});

authRouter.get("/csrf-token", requireAuth, (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ token: getCsrfToken(req) });
});
