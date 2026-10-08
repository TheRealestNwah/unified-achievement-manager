# CLAUDE.md

Unified Achievement Manager: a single-user Windows desktop app (Electron + embedded PostgreSQL) that merges Steam, Xbox, PSN, RetroAchievements, GOG, and RPCS3 achievements. The checkout folder is called `trophyverse`; the product, installer, and data folder are all "Unified Achievement Manager".

The default branch is `master`.

## Layout

- `server/`: Express + PostgreSQL backend. `src/app.ts` is the entry point; per-platform code lives in `src/{steam,xbox,psn,retro,gog,rpcs3}`, with `src/matching`, `src/scoring`, and `src/sync` shared across them. The dashboard is a single page in `server/public/index.html`. Migrations and one-off repair scripts are in `src/db`.
- `desktop/`: Electron shell (`src/main.ts`) that runs the server in-process, plus the Windows installer build (`npm run dist`, electron-builder).
- `db/schema.sql`: schema reference.
- `docs/`: `development.md` (running from source, API), `data-model.md` (tiers, matching, scoring), `operations.md`, `privacy.md`, `release-checklist.md`.
- `ROADMAP.md`: planned and released work.

## Build, lint, test

Server (`cd server`):

```bash
npm ci
npm run lint
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.test.json
npm test
```

Desktop (`cd desktop`): `npm ci`, then `npm run typecheck`. There's no desktop test runner; CI's Windows installer smoke test (`desktop/scripts/smoke-test.ps1`) covers it.

CI (`.github/workflows/ci.yml`) runs the server checks with a Postgres service, the desktop typecheck, and a Windows installer build + install/launch/uninstall smoke test. All three are required checks on `master`.

### Integration tests

Integration tests **truncate tables**, so never point them at real data. Use the separate `uam_test` database: set `DATABASE_URL` to it explicitly (the local `server/.env` points elsewhere), plus `INTEGRATION_TESTS=true` and `EMBEDDED_PG_TESTS=true` for the embedded-PG suite. Run `npm run db:migrate` against it after schema changes.

## Running locally

- `npm run dev` in `server/` serves the dashboard at http://127.0.0.1:3000 with data in `server/.dev-data`. The `uam-server` entry in `.claude/launch.json` starts it.
- Use `127.0.0.1`, not `localhost`: Steam sign-in loses its session otherwise.
- The server caches `index.html` in memory (`staticPages.ts`). Restart it after editing the dashboard or switching branches.
- Stopping the preview hard-kills the server and orphans the embedded PostgreSQL. Stop it with `pg_ctl stop -D server/.dev-data/postgres` (binary under `server/node_modules/@embedded-postgres/windows-x64/native/bin`) before moving or deleting the data folder.
- Two local servers on 127.0.0.1 share the `connect.sid` cookie and keep renewing each other's sessions. Run one at a time.
- Copying real data into `.dev-data` for QA: clear the stored platform access/refresh tokens and turn off background sync and Discord presence first, or a sync can rotate the installed app's real PSN/GOG tokens.

## Gotchas

- Working copies are CRLF. Edit with tools that preserve line endings; avoid multi-line string matching in scripts.
- The app is local and single-user by design (public profiles, leaderboards, and the multi-user server mode were removed in #392). Don't add features that need a shared server or other users without asking.
- The installer is unsigned for now (`CSC_IDENTITY_AUTO_DISCOVERY=false` in CI).
- Releases follow `docs/release-checklist.md`, and every release or tag needs explicit permission.
- There is intentionally no Dependabot (removed in #472): the owner prefers updating dependencies by hand for this solo project. Don't re-add it without asking.
