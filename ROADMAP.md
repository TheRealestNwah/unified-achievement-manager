# Build roadmap

## Next up

1.0 ships as a standalone Windows desktop app: an Electron shell around the server, with its own bundled PostgreSQL, a first-run Steam key setup, and an installer built and smoke-tested in CI ([#124](https://github.com/TheRealestNwah/unified-achievement-manager/issues/124)–[#129](https://github.com/TheRealestNwah/unified-achievement-manager/issues/129)). What remains is getting it out the door: **run the live parts of the [1.0 release checklist](docs/release-checklist.md)** on a real Windows machine (Steam sign-in, every platform, sync twice, disconnect/reconnect, crash recovery, uninstall/reinstall), then tag once approved.

After 1.0: code-sign the installer (removes the SmartScreen warning), auto-update, and macOS/Linux builds. The code is already cross-platform apart from the installer.

~~Add a Content-Security-Policy.~~ Done in [#123](https://github.com/TheRealestNwah/unified-achievement-manager/pull/123) (nonce-based).

~~Make `db:migrate` safe to re-run on an existing database.~~ Done - `db/schema.sql` now guards every `create table`/`create index` with `if not exists`, wraps the three enum types in the standard idempotent `do $$ ... exception when duplicate_object` block, and both seed inserts use `on conflict do nothing` so a re-run can't reset hand-tuned `tier_points` values. Verified by migrating a fresh database, then re-running `db:migrate` twice more against it with no error, and confirming a hand-edited `tier_points` row survives a re-run untouched.

Working discipline for unmonitored runs is unchanged: one focused PR per item, `npx tsc --noEmit` before every commit, live-verify against the real dev DB before merging where possible, and say plainly in the PR when a third-party API assumption couldn't be checked live. Check real API responses with `curl` rather than guessing from docs. File a new issue instead of building anything not listed here that comes up along the way.

## P0 — core (nothing works end-to-end without these)

| # | Component | Status | What it does |
|---|---|---|---|
| 1 | **User auth** | ✅ Done | Steam OpenID login is the identity system (no separate email/password). Sessions persisted in Postgres via `connect-pg-simple` so restarts don't log users out. |
| 2 | **Steam client** | ✅ Done | Pulls owned games + achievement unlocks via Steam's public API. |
| 3 | **Game matching job** | ✅ Done | Links each platform's game ID to one canonical `games` row (exact normalized-title matching). |
| 4 | **Achievement matching job** | ✅ Done | Word-overlap fuzzy match to a canonical row per game; auto-merges at confidence 1.0, queues 0.5–0.99 in `achievement_match_candidates`. A dashboard "Review matches" panel lets you confirm/reject queued candidates by hand. |
| 5 | **Scoring engine** | ✅ Done | Resolves tier (native/cross-match/rarity fallback, capped at gold) → points → level via `tier_points`/`level_thresholds`; recomputes `user_scores` on new unlocks. Sums *every* unlock across every linked platform — re-earning the same achievement on a second platform (a second platinum, a second 100%) counts again rather than being deduped. The level curve's exponent is fit against a real PSN account's level/points (see `server/src/scoring/levelCurve.ts`) rather than guessed — an earlier guess was off by ~3 orders of magnitude at high levels. |
| 6 | **Sync pipeline** | ✅ Done | Orchestrates 2–5 for a linked account: fetch unlocks, upsert games/achievements, run matching, trigger scoring. |
| 7 | **Backend API** | ✅ Done | Serves a user's unified profile (accounts, games, achievements, score, matching) — see README for the endpoint list. |
| 8 | **Dashboard UI** | ✅ Done | Combined per-game rows across platforms; expanding a game groups its achievement list by platform so multiple platinums/100%s on the same game each show up distinctly, with PSN's tier borrowed in either group. |

## P1 — platform expansion

| # | Component | Status | What it does |
|---|---|---|---|
| 9 | **Xbox client** | ✅ Done | OpenXBL-based OAuth + achievement pull (raw Microsoft OAuth was passed over — see PR history). Includes a merge of the modern and legacy (x360) achievement endpoints, since the modern one returns nothing for legacy titles. |
| 10 | **RetroAchievements client** | ✅ Done | Public API, no OAuth key exchange (a personal Web API key + username, same personal-key pattern as Xbox). No native tiers (`has_native_tiers = false`), so achievements are tiered from global unlock rarity like Steam/Xbox, using `NumDistinctPlayersCasual` as the rarity denominator. |
| 11 | **PSN client** | ✅ Done | Unofficial API (NPSSO token → OAuth exchange), implemented directly on Node's `https` module (Node's `fetch`/undici had a confirmed incompatibility with OpenXBL and was avoided here too). This is the scoring source of truth — its native trophy tier always wins when a match includes it. |
| 11b | **GOG client** | ✅ Done | Unofficial API following the community gogapidocs (paste-the-redirect-code login, since there's no callback we control). Verified against a real account in the 1.0 build ([#130](https://github.com/TheRealestNwah/unified-achievement-manager/issues/130)). Ubisoft Connect and Epic were researched under [#31](https://github.com/TheRealestNwah/unified-achievement-manager/issues/31) and not built. |

## P2 — polish & scale

| # | Component | Status | What it does |
|---|---|---|---|
| 12 | **Background job scheduler** | ✅ Done | Periodic re-sync of every linked account (`server/src/scheduler.ts`), off by default (`SCHEDULER_ENABLED`/`SCHEDULER_INTERVAL_MINUTES`). One account's sync failing (expired PSN token, revoked key) is logged and skipped rather than aborting the run. Runs matching + rescores everyone once per pass if anything synced. |
| 13 | **Rate-limit/caching layer** | ✅ Done | Steam's global achievement percentages are cached per appid for 24 hours (`steam_global_rarity_cache`), and Steam sync skips games whose playtime and last-played time haven't changed. Xbox sync retries transient 429s with backoff. Inbound API and auth routes are rate-limited (`RATE_LIMIT_*`). |
| 14 | **Public shareable profiles** | ❌ Removed | Shipped, then removed ([#124](https://github.com/TheRealestNwah/unified-achievement-manager/issues/124)) when 1.0 became a local, single-user desktop app with no shared server for other people to reach. |
| 15 | **Leaderboards / friend comparison** | ❌ Removed | Same as item 14 ([#124](https://github.com/TheRealestNwah/unified-achievement-manager/issues/124)). |
| 16 | **Per-game relative rarity tiering** | ✅ Done | Fixed global rarity thresholds (e.g. <15% = gold) don't adapt to games with atypical achievement distributions — e.g. Payday 2 had 1254 of 1342 achievements land in "gold". Fixed with a hybrid: games stay on fixed thresholds by default, but ones where >50% of achievements would land in gold get re-tiered by rank within their own achievement list instead. See [#10](https://github.com/TheRealestNwah/unified-achievement-manager/issues/10) and `server/src/scoring/rarityNormalization.ts`. |
| 17 | **Manual game linking** | ✅ Done | Automatic game matching only merges on exact normalized title (see item 3), which misses genuine same-game cases formatted differently per platform (e.g. "Skyrim" on PSN vs "The Elder Scrolls V: Skyrim" on Steam). "Link games" mode in the dashboard lets a user pick two of their own library entries to merge; re-runs achievement matching + rarity normalization scoped to just that game, not the whole library. `POST /api/matching/games/merge`. |
| 18 | **Platform-name label overflow bug** | ✅ Done | `.platform-name` now sizes to its content instead of a fixed 70px width. See [#18](https://github.com/TheRealestNwah/unified-achievement-manager/issues/18). |
| 19 | **Per-console platform breakdown** | ✅ Done | Display-only console-variant badges (PS3/PS4/PS5, Xbox 360/One/Series) from each platform's own per-title metadata, without changing the single-login account/sync model. Xbox badges are only shown where OpenXBL can actually confirm the console. See [#19](https://github.com/TheRealestNwah/unified-achievement-manager/issues/19). |

## Parked

- **EA/Origin** — no public API, no realistic path without violating ToS. Revisit only if a reliable third-party data source turns up.
- **Ubisoft Connect** — won't build. There's no public achievements API, the only known sign-in takes the user's raw email and password, and Ubisoft's terms prohibit unofficial API access with account sanctions as the penalty. Putting users' accounts at risk of a ban isn't worth it. See [#148](https://github.com/TheRealestNwah/unified-achievement-manager/issues/148) and [#31](https://github.com/TheRealestNwah/unified-achievement-manager/issues/31).
- **Epic Games Store** — achievements need per-game developer credentials, and most titles have none. See [#31](https://github.com/TheRealestNwah/unified-achievement-manager/issues/31).
- **Amazon Games / Prime Gaming** — no public API for library or achievements, and most titles have no platform-native achievement system to begin with, so there's nothing to sync even with an unofficial client. Known community tools (e.g. Playnite) only do local install/registry scraping for library detection, not achievements. See [#231](https://github.com/TheRealestNwah/unified-achievement-manager/issues/231).

## Suggested order

~~Auth → Steam client → game matching → achievement matching → scoring engine → sync pipeline → API → dashboard → Xbox → RetroAchievements → PSN → everything else.~~ Every P0/P1/P2 item is done. See "Next up" at the top for what's left before 1.0.
