# Build roadmap

## Released

1.0 shipped on 2026-09-27 as a standalone Windows desktop app: an Electron shell around the server, with its own bundled PostgreSQL, a first-run profile setup, and an installer built and smoke-tested in CI ([#124](https://github.com/TheRealestNwah/unified-achievement-manager/issues/124)–[#129](https://github.com/TheRealestNwah/unified-achievement-manager/issues/129)). The [Releases page](https://github.com/TheRealestNwah/unified-achievement-manager/releases) has the notes for every version.

| Version | Date | Highlights |
|---|---|---|
| [1.0.6](https://github.com/TheRealestNwah/unified-achievement-manager/releases/tag/v1.0.6) | 2026-10-08 | Minimizing the window no longer brings it back seconds later ([#514](https://github.com/TheRealestNwah/unified-achievement-manager/issues/514)); hovering a Recent activity row shows the achievement's description ([#516](https://github.com/TheRealestNwah/unified-achievement-manager/issues/516)). |
| [1.0.5](https://github.com/TheRealestNwah/unified-achievement-manager/releases/tag/v1.0.5) | 2026-10-03 | Rename a game to its SteamGridDB name from the game menu, even when only its cover came from SteamGridDB ([#504](https://github.com/TheRealestNwah/unified-achievement-manager/issues/504), [#506](https://github.com/TheRealestNwah/unified-achievement-manager/issues/506)). |
| [1.0.4](https://github.com/TheRealestNwah/unified-achievement-manager/releases/tag/v1.0.4) | 2026-10-02 | A visible **Check now** for updates ([#496](https://github.com/TheRealestNwah/unified-achievement-manager/issues/496)); the app shell no longer scrolls off-screen ([#494](https://github.com/TheRealestNwah/unified-achievement-manager/issues/494)); MIT license ([#492](https://github.com/TheRealestNwah/unified-achievement-manager/issues/492)). |
| [1.0.3](https://github.com/TheRealestNwah/unified-achievement-manager/releases/tag/v1.0.3) | 2026-09-29 | Review confirms and Find matches take seconds, not minutes ([#482](https://github.com/TheRealestNwah/unified-achievement-manager/issues/482)); Xbox catalog lookups no longer use up the OpenXBL quota ([#478](https://github.com/TheRealestNwah/unified-achievement-manager/issues/478)); Find matches stops recounting rejected matches ([#480](https://github.com/TheRealestNwah/unified-achievement-manager/issues/480)). |
| [1.0.2](https://github.com/TheRealestNwah/unified-achievement-manager/releases/tag/v1.0.2) | 2026-09-29 | The sidebar shows the running version ([#474](https://github.com/TheRealestNwah/unified-achievement-manager/issues/474)); dependency updates. |
| [1.0.1](https://github.com/TheRealestNwah/unified-achievement-manager/releases/tag/v1.0.1) | 2026-09-29 | The first release installed copies update to on their own. Fixes from post-1.0 QA: database-stopped handling ([#415](https://github.com/TheRealestNwah/unified-achievement-manager/issues/415), [#419](https://github.com/TheRealestNwah/unified-achievement-manager/issues/419)), expired PSN/GOG logins ([#424](https://github.com/TheRealestNwah/unified-achievement-manager/issues/424)), session-renewal buttons ([#438](https://github.com/TheRealestNwah/unified-achievement-manager/issues/438)). |

## Next up

- Code-sign the installer, which removes the SmartScreen warning.
- macOS preview builds and native packaged-app CI ([#510](https://github.com/TheRealestNwah/unified-achievement-manager/issues/510)); signing, notarization and real-Mac acceptance remain before release. See [macOS preview](docs/macos.md). Linux packaging remains future work.
- Run the hands-on auto-update check in the [release checklist](docs/release-checklist.md) by hand. Auto-update from GitHub Releases ([#314](https://github.com/TheRealestNwah/unified-achievement-manager/issues/314)) is live from 1.0.1.

New work that comes up along the way gets its own issue rather than being built unlisted.

## P0 — core (nothing works end-to-end without these)

| # | Component | Status | What it does |
|---|---|---|---|
| 1 | **User auth** | ✅ Done | A local profile, named on first run, with no sign-in ([#393](https://github.com/TheRealestNwah/unified-achievement-manager/issues/393)). Steam OpenID was the identity until then; now it only confirms which Steam account to link. |
| 2 | **Steam client** | ✅ Done | Pulls owned games + achievement unlocks via Steam's public API. |
| 3 | **Game matching job** | ✅ Done | Links each platform's game ID to one canonical `games` row (exact normalized-title matching auto-merges; legacy-platform, duplicate, and near-title matches go to review - see [docs/data-model.md](docs/data-model.md)). |
| 4 | **Achievement matching job** | ✅ Done | Word-overlap fuzzy match to a canonical row per game; auto-merges at confidence 1.0, queues 0.5–0.99 in `achievement_match_candidates`. The Review page lets you confirm/reject queued candidates by hand, alongside the Game merges and Possible bad merges queues. |
| 5 | **Scoring engine** | ✅ Done | Resolves tier (native/cross-match/rarity fallback, capped at gold) → points → level via `tier_points`/`level_thresholds`; recomputes `user_scores` on new unlocks. Sums *every* unlock across every linked platform — re-earning the same achievement on a second platform (a second platinum, a second 100%) counts again rather than being deduped. The level curve's exponent is fit against a real PSN account's level/points (see `server/src/scoring/levelCurve.ts`) rather than guessed — an earlier guess was off by ~3 orders of magnitude at high levels. |
| 6 | **Sync pipeline** | ✅ Done | Orchestrates 2–5 for a linked account: fetch unlocks, upsert games/achievements, run matching, trigger scoring. |
| 7 | **Backend API** | ✅ Done | Serves a user's unified profile (accounts, games, achievements, score, matching) — see [docs/development.md](docs/development.md) for the endpoint list. |
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
| 12 | **Background job scheduler** | ✅ Done | Periodic re-sync of every linked account (`server/src/scheduler.ts`), every 6 hours by default, changeable under Settings → Background sync. One account's sync failing (expired PSN token, revoked key) is logged and skipped rather than aborting the run. Runs matching + rescores everyone once per pass if anything synced. |
| 13 | **Rate-limit/caching layer** | ✅ Done | Steam's global achievement percentages are cached per appid for 24 hours (`steam_global_rarity_cache`), and Steam sync skips games whose playtime and last-played time haven't changed. Xbox sync retries transient 429s with backoff and skips titles whose progress hasn't changed. Inbound API and auth routes are rate-limited. |
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
