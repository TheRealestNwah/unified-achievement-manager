import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { getUserScore } from "./index";
import { GOLD_RARITY_THRESHOLD, SILVER_RARITY_THRESHOLD, TIER_POINTS } from "./tier";
import { SKEW_GOLD_SHARE } from "./rarityNormalization";

export const scoreRouter = Router();

// The numbers behind tiers and XP, for the dashboard's "How scoring works"
// explainer (see #287) - served rather than copied into the page so the two
// can't drift apart.
scoreRouter.get("/scoring-rules", requireAuth, (_req, res) => {
    res.json({
        tierPoints: TIER_POINTS,
        goldRarityBelow: GOLD_RARITY_THRESHOLD,
        silverRarityBelow: SILVER_RARITY_THRESHOLD,
        skewedGoldShare: SKEW_GOLD_SHARE,
    });
});

scoreRouter.get("/score", requireAuth, async (req, res, next) => {
    try {
        res.json(await getUserScore(req.user!.id));
    } catch (err) {
        next(err);
    }
});
