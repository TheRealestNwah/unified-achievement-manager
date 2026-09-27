# Development

The repository has two packages:

- `server/`: the Express + PostgreSQL backend and the dashboard (`server/public`). It always runs as a single-user app with its own bundled PostgreSQL (`server/src/app.ts`).
- `desktop/`: the Electron shell that runs app mode in-process and shows the dashboard in a window, plus the Windows installer build.

## Running from source

### Desktop app (recommended)

```bash
cd server
npm install
cd ../desktop
npm install
npm start          # builds the server, then launches Electron
```

The app uses the same data folder as an installed copy (`%APPDATA%\Unified Achievement Manager`). Point it somewhere else with `UAM_DATA_DIR`. If `npm start` complains that Electron failed to install (npm 11 can block dependency install scripts), run `node node_modules/electron/install.js` in `desktop/`.

### Server without Electron

```bash
cd server
npm install
npm run dev        # restarts on code changes; or `npm run app` to run once
```

It serves the dashboard at http://127.0.0.1:3000 (use `127.0.0.1`, not `localhost`, or Steam sign-in loses its session). Data goes in `server/.dev-data`, never the installed app's folder, so it can run while the installed app is open. It starts empty, so either set it up from scratch or restore a backup into it: quit it, then extract a **File → Back Up…** file into `server/.dev-data`. `UAM_DATA_DIR` and `PORT` override the folder and port. The dashboard page is cached in memory, so restart after editing `server/public/index.html`.

There used to be a multi-user "classic server" mode with an external PostgreSQL and a `.env`. It was removed in [#392](https://github.com/TheRealestNwah/unified-achievement-manager/issues/392).

## Building the installer

On Windows:

```bash
cd desktop
npm run dist
```

This builds the server, stages it with production-only dependencies (`desktop/scripts/stage-server.mjs`), and writes `desktop/release/Unified-Achievement-Manager-Setup-<version>.exe`. `desktop/scripts/smoke-test.ps1 -Installer <path>` installs it silently into a temp folder, launches it in smoke-test mode, uninstalls it, and checks nothing is left running.

The installer is currently unsigned. Code signing needs a certificate; electron-builder picks one up from `CSC_LINK`/`CSC_KEY_PASSWORD` once one exists.

## Tests and CI

From `server/`:

```bash
npm run lint
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.test.json
npm test
```

Integration tests need `INTEGRATION_TESTS=true` and a `DATABASE_URL` for a throwaway PostgreSQL database, since they truncate tables. Put it in `server/.env` (see `server/.env.example`) or the environment, and run `npm run db:migrate` against it after schema changes. The embedded-PostgreSQL tests need `EMBEDDED_PG_TESTS=true`. CI (`.github/workflows/ci.yml`) runs all of the above against PostgreSQL 16 on every pull request, typechecks `desktop/`, and on Windows builds the installer, runs the smoke test, and uploads the installer as the `Unified-Achievement-Manager-Setup` artifact.

## How the app works

- **Data folder:** `secrets.json` holds the session secret and the credential-encryption key, generated once on first run and never regenerated. `database.json` holds the embedded database password. `postgres/` is the PostgreSQL cluster, `uploads/` holds cover and icon overrides, and `logs/main.log` is the app log.
- **Database:** PostgreSQL 17 from the `@embedded-postgres/*` binary packages, driven through `pg_ctl` (`server/src/runtime/embeddedDatabase.ts`). It listens on `127.0.0.1` at a free port and is fast-stopped on quit. An instance orphaned by a crash is stopped on the next launch, and by the installer and uninstaller.
- **Server:** binds `127.0.0.1` on the port saved in `app.json`, or a new free port (then saved) when that one is taken. Keeping the port stable keeps the dashboard's origin stable, so its `localStorage` preferences survive restarts. Rate limits are loose, since only this machine can reach the server, and background sync runs every 6 hours until the user changes it. `.env` files are ignored.
- **Window:** Steam OpenID sign-in stays in the window so the session cookie lands in the app. Every other link opens in the system browser.

## HTTP API

The dashboard is a thin client over these routes. Everything needs the signed-in session unless noted, and state-changing requests need the `X-CSRF-Token` from `GET /api/setup/status` or `GET /auth/csrf-token`.

**Sign-in and setup**

- `GET /auth/steam`: Steam OpenID sign-in; `GET /auth/me`: the signed-in user; `POST /auth/logout`
- `GET /api/setup/status`: whether a Steam Web API key is configured, plus a CSRF token (works before sign-in)
- `PUT /api/setup/steam-api-key` (body: `{ apiKey }`): set the Steam Web API key (open until one exists; replacing it needs a session)
- `GET /api/setup/desktop-settings`, `GET /api/setup/new-unlocks` (query: `since`), `GET /api/setup/discord-presence-data`: read by the Electron main process, which has no session cookie, so they're unauthenticated. Safe only because the server binds `127.0.0.1`

**Platforms**

- `POST /api/xbox/connect` (body: `{ apiKey }`), `POST /api/psn/connect` (body: `{ npsso }`), `POST /api/retro/connect` (body: `{ username, apiKey }`), `POST /api/gog/connect` (body: `{ code }`): link an account
- `GET /api/gog/login-url`: the GOG login page whose redirect carries the `code` for `/api/gog/connect`
- `POST /api/steam/sync`, `POST /api/xbox/sync`, `POST /api/psn/sync`, `POST /api/retro/sync`, `POST /api/gog/sync`: pull each platform's library and unlocks, and recompute the score
- `GET /api/me/accounts`: linked platforms, when each last synced, and whether a sync is running
- `GET /api/me/sync-status`: a cheap "anything new since I last looked" check the dashboard polls, plus the next scheduled sync and which platforms are syncing now
- `DELETE /api/me/accounts/:platformId`: disconnect a platform (not Steam) and remove its synced data

**Library**

- `GET /api/me/games`: the combined library; `GET /api/me/games/:gameId`: one game's header data, including hidden and excluded games
- `GET /api/me/games/:gameId/achievements`: one game's achievements per platform; `GET /api/me/games/:gameId/platforms`: the platform entries it's made of, for the split control
- `PUT /api/me/games/:gameId/title` (body: `{ gamePlatformLinkId }` or `{ title }`): pick one platform's title or type your own; `PUT /api/me/games/:gameId/title/steamgriddb` (body: `{ sgdbGameId }`): use a SteamGridDB game's name
- `PUT /api/me/games/:gameId/visibility` (body: `{ mode: "hidden" | "excluded" }`), `DELETE` to undo; `GET /api/me/games/hidden`: hidden and excluded games
- `PUT /api/me/games/:gameId/cover` (body: `{ url }`), `POST /api/me/games/:gameId/cover/upload` (multipart `file`), `DELETE /api/me/games/:gameId/cover`: cover overrides. The same three routes exist under `/api/me/achievements/:achievementId/icon`
- `GET /api/me/games/:gameId/cover/steamgriddb/search` (query: `term`, `sgdbGameId`, `styles`, `animated`): SteamGridDB portrait covers for a game, by Steam app ID or title search; `POST /api/me/games/:gameId/cover/steamgriddb/select` (body: `{ url }`) downloads a picked `cdn2.steamgriddb.com/grid/` image and sets it as the cover
- `GET /api/me/activity` (query: `limit`, `offset`), `GET /api/me/stats`, `GET /api/me/score`, `GET /api/me/scoring-rules`: recent unlocks, fun stats, the total points, level, and progress, and the tier points and rarity thresholds behind "How is this worked out?"
- `GET /api/me/export` (`?format=json` or `?format=csv`): unlock history
- `DELETE /api/me/account` (body: `{ confirmation: "DELETE" }`): permanently delete the signed-in account and its private data

**Matching and review**

- `POST /api/matching/run`: link matched games and achievements across all connected platforms (also `npm run match`)
- `POST /api/matching/games/merge` (body: `{ keepGameId, mergeGameId }`): manually merge two library entries; `POST /api/matching/games/:gameId/split` (body: `{ gamePlatformLinkId }`): split one platform entry back out
- The three review queues share one shape. `GET` lists pending items; `POST /:id/confirm`, `POST /:id/reject`, and `POST /:id/reopen` (undo a rejection) act on one; `POST /bulk` (body: `{ ids, action: "confirm" | "reject" }`) acts on many with a single rescore:
  - `/api/matching/candidates`: uncertain achievement matches
  - `/api/matching/game-candidates`: suggested whole-game merges
  - `/api/matching/game-split-candidates`: possible bad merges, where confirm splits the flagged platform entry out

**Settings**

- `GET`/`PUT /api/settings/discord-rich-presence` (body: `{ enabled }`)
- `GET`/`PUT /api/settings/sync-interval` (body: `{ minutes }`, `null` for off)
- `GET`/`PUT /api/settings/desktop`: tray, start-with-Windows, unlock notification, and automatic update switches
- `GET`/`PUT /api/settings/search-acronyms`: the user's own acronym list
- `GET /api/settings/steamgriddb-api-key`: whether a SteamGridDB key is saved; `PUT` (body: `{ apiKey }`) checks the key with SteamGridDB and saves it; `DELETE` removes it

**Health**

- `GET /healthz` (liveness) and `GET /readyz` (database reachable)

## Scoring and security notes

An achievement's tier is inherited from PSN (`tier_source = 'psn_native'`) or inferred from global unlock rarity (`'rarity_fallback'`), capped at gold. Games with a skewed rarity distribution are ranked within their own list instead. See [data-model.md](data-model.md). The level curve lives in `server/src/scoring/levelCurve.ts`. After retuning it, run `npm run db:seed-levels` and `npm run db:rescore-all`.

Platform credentials and the Steam Web API key are encrypted at rest with AES-256-GCM. Sessions use `HttpOnly`, `SameSite=Lax` cookies. The server only listens on `127.0.0.1`, and the dashboard is served with a nonce-based Content-Security-Policy.
