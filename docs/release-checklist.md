# 1.0 release checklist

A green CI run is required, but it doesn't replace the live checks below. **Do not create or push a release tag, or publish a GitHub Release, until the release owner explicitly approves it.**

## Before the release candidate

- [ ] Every 1.0 issue is closed, and every PR is linked to an issue and carries the repository's established label.
- [ ] `master` is clean and current, and its CI is green: server lint/typecheck/unit/integration/embedded-PostgreSQL tests, the `desktop` typecheck, and the `windows-installer` job, including its install → launch → uninstall smoke test.
- [ ] `npm audit --omit=dev` in `server/` and `desktop/`. Review any remaining advisory rather than suppressing it.
- [ ] `desktop/package.json` and `server/package.json` versions match the version being released.
- [ ] Download the `Unified-Achievement-Manager-Setup` artifact from the release commit's CI run. Those exact files (the installer, its `.blockmap`, and `latest.yml`) are what get published.

## Installer smoke test (on a real Windows machine, not a dev checkout)

- [ ] **Fresh install:** with no `%APPDATA%\Unified Achievement Manager`, run the installer. The SmartScreen "unrecognized app" prompt is expected while the build is unsigned. The install completes without an admin prompt, and the Start menu and desktop shortcuts exist.
- [ ] **First run:** the loading screen appears, then the Steam Web API key setup. A mistyped key and a made-up key are both rejected. A real key is accepted.
- [ ] **Steam sign-in:** Steam's page opens inside the app, sign-in completes, and you land on the dashboard. Quit and relaunch: still signed in.
- [ ] **Platforms:** link one account on each platform. External links (xbl.io, PSN token page, GOG login, RetroAchievements settings) open in the system browser. Sync each twice and confirm the second sync doesn't duplicate games, achievements, ownership, or unlocks.
- [ ] **Everyday features:** find/review matches, link games, set a cover via URL and via upload, and export JSON and CSV (the save dialog appears).
- [ ] **Disconnect/reconnect** one platform, then **delete account**. The confirmation dialog requires `DELETE`, private data is gone, and uploaded overrides are removed.
- [ ] **Single instance:** launching a second copy focuses the first window instead.
- [ ] **Clean quit:** after closing the window, no `Unified Achievement Manager.exe` or bundled `postgres.exe` remains in Task Manager.
- [ ] **Crash recovery:** end `Unified Achievement Manager.exe` in Task Manager, then relaunch. It starts normally.
- [ ] **Uninstall/reinstall:** uninstall. The program folder is gone and `%APPDATA%\Unified Achievement Manager` remains. Reinstall, and the data is still there.
- [ ] **Upgrade** (from 1.0.1 onward): install the previous release, add data, then install the candidate over it. Data and sign-in survive.
- [ ] **Auto-update** (from 1.0.1 onward): with the previous release installed and the candidate published, Help → Check for Updates finds it, downloads it, and "Restart now" relaunches on the new version with data and sign-in intact. Repeat with "Later" and confirm it installs on quit.
- [ ] **Your own PostgreSQL untouched:** on a machine that also runs a separately installed PostgreSQL, install, crash-recover, and uninstall without affecting it.

## Publishing (only after explicit approval)

- [ ] Tag the release commit (`v<version>`) and publish a GitHub Release with `Unified-Achievement-Manager-Setup-<version>.exe`, its `.blockmap`, and `latest.yml` attached - installed copies auto-update from the latest release's `latest.yml`, so a release without it is invisible to them. Publish as a full release, not a draft or pre-release and short release notes: what's new, the SmartScreen note, and where data lives.
- [ ] Record the commit, the CI run the installer came from, and the smoke-test results in the release notes.
- [ ] Branch cleanup happens only after PRs are merged.

## Rollback

Users keep their data folder across uninstalls, so a bad release is rolled back by pointing people at the previous installer: uninstall, then install the older version. Changes to `db/schema.sql` must stay backward compatible within 1.x so an older version can still open a newer data folder. Never ship anything that regenerates `secrets.json`.
