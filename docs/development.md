# Development

The repository has two packages:

- `server/`: the Express + PostgreSQL backend and the dashboard (`server/public`). It can run as a classic server, or in self-contained app mode with its own bundled PostgreSQL (`server/src/app.ts`).
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

### App mode without Electron

```bash
cd server
npm install
npm run app        # bundled PostgreSQL, no .env; prints the URL to open
```

### Classic server mode

Uses an external PostgreSQL and a `.env` (see `server/.env.example`):

```bash
cd server
cp .env.example .env
npm install
npm run db:migrate     # applies db/schema.sql and seeds the level curve (safe to re-run)
npm run dev
```

`STEAM_API_KEY` is optional; without it the dashboard asks for one on first run. `SCHEDULER_ENABLED=true` turns on the background re-sync (always on by default in app mode).

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

Integration tests need `INTEGRATION_TESTS=true` and a `DATABASE_URL`. The embedded-PostgreSQL tests need `EMBEDDED_PG_TESTS=true`. CI (`.github/workflows/ci.yml`) runs all of the above against PostgreSQL 16 on every pull request, typechecks `desktop/`, and on Windows builds the installer, runs the smoke test, and uploads the installer as the `Unified-Achievement-Manager-Setup` artifact.

## How app mode works

- **Data folder:** `secrets.json` holds the session secret and the credential-encryption key, generated once on first run and never regenerated. `database.json` holds the embedded database password. `postgres/` is the PostgreSQL cluster, `uploads/` holds cover and icon overrides, and `logs/main.log` is the app log.
- **Database:** PostgreSQL 17 from the `@embedded-postgres/*` binary packages, driven through `pg_ctl` (`server/src/runtime/embeddedDatabase.ts`). It listens on `127.0.0.1` at a free port and is fast-stopped on quit. An instance orphaned by a crash is stopped on the next launch, and by the installer and uninstaller.
- **Server:** binds `127.0.0.1` on the port saved in `app.json`, or a new free port (then saved) when that one is taken. Keeping the port stable keeps the dashboard's origin stable, so its `localStorage` preferences survive restarts. Rate limits are loosened and the scheduler is on by default. `.env` files are ignored.
- **Window:** Steam OpenID sign-in stays in the window so the session cookie lands in the app. Every other link opens in the system browser.

## HTTP API

The dashboard is a thin client over these routes (all under the signed-in session, and state-changing requests need the `X-CSRF-Token` from `GET /api/setup/status`):

- `GET /api/setup/status`: whether a Steam Web API key is configured, plus a CSRF token (works before sign-in)
- `PUT /api/setup/steam-api-key` (body: `{ apiKey }`): set the Steam Web API key (open until one exists; replacing it needs a session)
- `GET /api/settings/steamgriddb-api-key`: whether a SteamGridDB key is saved; `PUT` (body: `{ apiKey }`) checks the key with SteamGridDB and saves it; `DELETE` removes it
- `GET /api/me/games/:gameId/cover/steamgriddb/search` (query: `term`, `sgdbGameId`, `styles`, `animated`): SteamGridDB portrait covers for a game, by Steam app ID or title search; `POST /api/me/games/:gameId/cover/steamgriddb/select` (body: `{ url }`) downloads a picked `cdn2.steamgriddb.com/grid/` image and sets it as the cover
- `POST /api/steam/sync`, `POST /api/xbox/sync`, `POST /api/psn/sync`, `POST /api/retro/sync`, `POST /api/gog/sync`: pull each platform's library and unlocks, and recompute the score
- `POST /api/xbox/connect` (body: `{ apiKey }`), `POST /api/psn/connect` (body: `{ npsso }`), `POST /api/retro/connect` (body: `{ username, apiKey }`), `POST /api/gog/connect` (body: `{ code }`): link an account
- `GET /api/gog/login-url`: the GOG login page whose redirect carries the `code` for `/api/gog/connect`
- `POST /api/matching/run`: link matched games and achievements across all connected platforms (also `npm run match`)
- `GET /api/matching/candidates`, `POST /api/matching/candidates/:id/confirm`, `POST /api/matching/candidates/:id/reject`: the review queue for uncertain achievement matches
- `GET /api/matching/game-candidates`, `POST /api/matching/game-candidates/:id/confirm`, `POST /api/matching/game-candidates/:id/reject`: the same for whole-game merges
- `POST /api/matching/games/merge` (body: `{ keepGameId, mergeGameId }`): manually merge two library entries
- `GET /api/me/accounts`: linked platforms and when each last synced
- `DELETE /api/me/accounts/:platformId`: disconnect a platform (not Steam) and remove its synced data
- `DELETE /api/me/account` (body: `{ confirmation: "DELETE" }`): permanently delete the signed-in account and its private data
- `GET /api/me/games`, `GET /api/me/games/:gameId/achievements`: the combined library, and one game's achievements per platform
- `GET /api/me/activity`, `GET /api/me/stats`, `GET /api/me/score`: recent unlocks, fun stats, and the total points, level, and progress
- `GET /api/me/export` (`?format=json` or `?format=csv`): unlock history
- `PUT /api/me/games/:gameId/cover` (body: `{ url }`), `POST /api/me/games/:gameId/cover/upload` (multipart `file`), `DELETE /api/me/games/:gameId/cover`: cover overrides. The same three routes exist under `/api/me/achievements/:achievementId/icon`
- `GET /healthz` (liveness) and `GET /readyz` (database reachable)

## Scoring and security notes

An achievement's tier is inherited from PSN (`tier_source = 'psn_native'`) or inferred from global unlock rarity (`'rarity_fallback'`), capped at gold. Games with a skewed rarity distribution are ranked within their own list instead. See [data-model.md](data-model.md). The level curve lives in `server/src/scoring/levelCurve.ts`. After retuning it, run `npm run db:seed-levels` and `npm run db:rescore-all`.

Platform credentials and the Steam Web API key are encrypted at rest with AES-256-GCM. Sessions use `HttpOnly`, `SameSite=Lax` cookies (`Secure` when `BASE_URL` is HTTPS). The dashboard is served with a nonce-based Content-Security-Policy. Classic server deployments behind a reverse proxy should set `TRUST_PROXY=true`. For an existing classic deployment with plaintext credential rows, run `npm run db:encrypt-platform-credentials` once.
