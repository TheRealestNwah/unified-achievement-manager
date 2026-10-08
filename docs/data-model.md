# Data model

Schema lives in [`db/schema.sql`](../db/schema.sql). This doc explains the reasoning.

## Core idea

Every real-world game and achievement gets exactly one **canonical** row, no matter how many platforms it appears on. Platform-specific data hangs off that canonical row through a link table. This is what lets every platform's copy of an achievement share one authoritative tier/value, borrowed from PSN when a match exists.

```
games ---------------< game_platform_links >--------------- platforms
  |
  v
canonical_achievements ---< achievement_platform_links >--- platforms
                                      |
                                      v
                          user_achievement_unlocks
                                      |
                                      v
                          user_platform_accounts ---< users
```

## Why canonical + link tables, not one flat table

If a user owns *Hades* on both Steam and PSN, the two copies' achievements are still the *same real achievement* and should be worth the same amount — specifically, whatever PSN's own trophy says it's worth, not a separate rarity guess per platform. Storing achievements per-platform with a link back to a shared canonical row is what makes that tier-sharing a join instead of app-level logic scattered everywhere.

This is a **shared value lookup, not a dedup mechanism** — a user who unlocks "Escape" on both Steam and PSN gets credited for both. Re-earning something on a second platform (a second platinum, a second 100%) is a real accomplishment worth counting twice, matching how PSN itself treats a PS4 and PS5 version of the same game as two separate trophy lists. See "Scoring counts every unlock, not every achievement" below.

## Scoring fields live on `canonical_achievements`

- `tier` — bronze/silver/gold/platinum, PSN-style
- `tier_source` — records *why* it has that tier:
  - `psn_native`: the game has a real PSN release; this is its actual trophy tier. RPCS3 trophies use it too, since they are the same PS3 trophy list read from the emulator's files
  - `cross_platform_match`: reserved for "no PSN copy of *this* achievement, but it was matched to one that has a tier" — defined in the schema but not currently produced: when a merge involves a `psn_native` row, that row wins outright and keeps its own `tier_source` rather than relabeling the merged result
  - `rarity_fallback`: no PSN release exists at all; tier inferred from `global_unlock_rarity` on `achievement_platform_links`
- `points` — denormalized from `tier_points` at resolution time, so scoring never needs a join at read time

Keeping `tier_source` explicit means you can always answer "why does this achievement have this score" and re-run matching later without losing track of which tiers were authoritative vs. guessed.

## Matching is a queue, not a black box

`achievement_match_candidates` holds proposed links between a platform achievement and a canonical achievement, with a `confidence` score and `pending/confirmed/rejected` status. High-confidence matches (e.g. identical name + description) can auto-confirm; low-confidence ones sit for manual review. This keeps the fuzzy-matching algorithm's mistakes correctable without re-scraping anything.

## Game matching auto-merges only exact titles, and queues the rest

Game matching (`matchGames`, `gameMatcher.ts`) only auto-merges on an exact normalized title, since two games with similar titles (`Skyrim` vs `Skyrim Special Edition`) are often genuinely different achievement lists, and a wrong automatic merge is much harder to undo cleanly than a wrong achievement merge. Anything riskier goes to `game_merge_candidates` (the Review page's **Game merges** tab) for a human instead:

- An exact title where one side is RetroAchievements or a legacy-only PSN/Xbox release, since a modern remake can share its original's exact name (`Resident Evil 2` 1998 vs. 2019).
- An exact title that already appears on more than one game on the same platform, the only available sign that it may cover different releases.
- A near-title match: one title is the other plus an appended suffix (`Grand Theft Auto V` vs. `Grand Theft Auto V: Legacy`).

`game_split_candidates` (the **Possible bad merges** tab) is the other direction: `detectLegacySignalSplitCandidates` flags games that already combine a legacy-signal platform entry with a modern one, the shape auto-merge now refuses to create. Confirming splits that entry back out. Confirmed, rejected, and pending rows are all kept, so a decision isn't asked again.

Title differences too large for either pass (`Skyrim` on PSN vs `The Elder Scrolls V: Skyrim` on Steam) are left to the user. `POST /api/matching/games/merge` exposes the same `mergeGames` function used internally, gated on the requesting user owning both games, for the dashboard's "Link games" mode, and `POST /api/matching/games/:gameId/split` (`splitPlatformLink`, `gameSplitter.ts`) undoes a merge one platform entry at a time. A manual merge re-runs achievement matching and rarity normalization scoped to just the merged game (`matchAchievementsForGame`/`normalizeRarityTiersForGame`, not the `*ForAllGames` variants) rather than the full `runMatching()` pipeline, since re-scanning the entire library for an interactive single-game merge made the button take ~20 seconds against a 570-game library.

## Scoring counts every unlock, not every achievement

`recomputeUserScore` sums `points` across every row in `user_achievement_unlocks` for the user, joined through to each unlock's own `achievement_platform_links` → `canonical_achievements` for that platform copy's tier. It does **not** dedupe by `canonical_achievement_id` — the same real achievement unlocked via two different linked platform accounts counts twice. The games list (`/api/me/games`) already summed each platform's own totals this way from the start (a side effect of joining through `achievement_platform_links`, which fans out once per platform link); scoring now matches that same philosophy instead of being the one place that deduped.

The achievement-detail view (`/api/me/games/:gameId/achievements`) returns one row per `(canonical_achievement, platform_link)` pair for the same reason — grouped by platform in the UI, so a matched achievement's separate PSN and Steam completions both show up, each with that platform's own unlock status.

## An unlock's date can be unknown

`user_achievement_unlocks.unlocked_at` is the time the platform says the achievement was earned, or null when it gives none worth trusting: legacy Xbox 360 unlocks often come back with a 1752 sentinel, and Steam reports 0 for some old unlocks. Null unlocks count toward scores and completion like any other, but they're left out of Recent activity and the date-based fun stats. A later sync that does get a date fills it in ([#423](https://github.com/TheRealestNwah/unified-achievement-manager/issues/423)). Before 1.0.1 such unlocks were stamped with the sync's own time; a one-off repair at startup clears those.

## Scoring is cached, not computed live

`user_scores` holds each user's current `total_points` and `level`, recomputed by a job whenever new unlocks come in (and for everyone when the desktop app starts). The dashboard reads the cache, not a live join, so showing the score stays cheap.

## Level curve

`level_thresholds` stores precomputed `(level, points_required)` pairs rather than a formula evaluated at query time, so the curve can be regenerated or tuned (`points_required(L) = round(BASE * (L-1)^EXPONENT)`, in `server/src/scoring/levelCurve.ts`) without touching application code.

PSN's own curve is undisclosed, so `EXPONENT` is fit against a real calibration point rather than guessed: a real PSN account at level 323 has 81,030 real trophy points (using the same bronze=15/silver=30/gold=90/platinum=300 values this app uses). An earlier `EXPONENT` of 2.4 was picked with no such anchor and was off by roughly three orders of magnitude at high levels — it demanded ~43,000,000 points for level 300, so that same real account (81,030 PSN points, ~185,000 combined across all three linked platforms) was stuck at level 31 instead of tracking anywhere near its real PSN level. `EXPONENT = 1.28` reproduces that anchor almost exactly (81,030 points lands at level 322).

Since this is fit from a single real data point rather than Sony's actual formula, retuning `level_thresholds` after any curve change requires re-running both `npm run db:seed-levels` (regenerates the thresholds table) and `npm run db:rescore-all` (refreshes every user's cached `level`, since `total_points` is always live but `level` is only recomputed when a sync or match job runs).

## Per-game rarity tiering for skewed games

`resolveTierFromRarity` (see `server/src/scoring/tier.ts`) uses fixed global thresholds (<15% unlock = gold, <50% = silver, else bronze) for the `rarity_fallback` case, applied per-achievement at insert/merge time before a game's full achievement list is known. This is fine for most games, but some (Payday 2: 1254 of 1342 achievements under 15% global unlock) have such a skewed rarity distribution that fixed thresholds collapse nearly the entire list into "gold," making the tier meaningless for that game.

`normalizeRarityTiersForGame`/`normalizeRarityTiersForAllGames` (`server/src/scoring/rarityNormalization.ts`) run after each game's achievements are fully synced (and again after matching, since merges can change a game's achievement set) to correct this. For each game's `rarity_fallback` achievements, it checks what fraction would land in "gold" under the fixed thresholds; if that share is implausibly high (>50%, tuned against real data — see below), it instead buckets that game's achievements by their own rank within the game (`planPercentileTiers`), using the same 15/50 percentile split so tier proportions stay roughly comparable across games even though rarity magnitudes aren't. Otherwise the game keeps the ordinary fixed-threshold tiers untouched.

The 50%-gold-share trigger was tuned against real synced data, not guessed: a naive "median rarity below 15%" trigger was tried first and rejected because it fired for the *majority* of the library — Steam's overall completion rates run low across nearly every game (Half-Life 2's median achievement rarity is 7.1%, Portal's is 12%), not just true outliers. Measuring the actual gold share directly instead correctly separates Payday 2 (93% gold under fixed thresholds) from ordinary games like Half-Life 2/Portal (~14%, left on fixed thresholds). One-off correction for pre-existing data: `npm run fix:rarity-tiering`.

This was tracked as [issue #10](https://github.com/TheRealestNwah/unified-achievement-manager/issues/10).

## Not yet modeled

- Auth/session tables beyond what's in `db/schema.sql` — sessions are handled by `connect-pg-simple`, not part of the canonical/link model this doc describes.
