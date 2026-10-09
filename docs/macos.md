# macOS preview

The Electron app now has native Apple Silicon (`arm64`) and Intel (`x64`) build targets. These are development previews built by PR CI, not a published Mac release. Windows releases continue unchanged.

## Build and install

On a Mac, install Node.js 22, then run `npm ci` in both `server/` and `desktop/`. From `desktop/`, run `npm run dist:mac`. Build on the architecture you intend to distribute: the staged PostgreSQL binaries match the build host. Do not pass an alternate architecture or attempt a universal build.

The output is `desktop/release/Unified-Achievement-Manager-<version>-mac-<arch>.dmg` and `.zip`. CI builds both architectures independently and uploads packages, smoke-test logs and dashboard screenshots as `Unified-Achievement-Manager-mac-<arch>` artifacts. Open the DMG and drag the app into Applications, then launch it there.

Preview builds are unsigned and unnotarized. Gatekeeper may block downloaded builds; only approve a preview you trust using macOS Privacy & Security. Do not disable Gatekeeper globally. Automatic updates are disabled for Mac previews; **Check now** opens the Actions builds page. Signed releases and update metadata are still future work.

## Mac behavior and data

- The application menu provides About, Hide and Quit; Edit and Window use native Mac menus.
- Closing the window keeps the app and background sync running. Click its Dock icon to reopen; use Cmd+Q to quit and stop PostgreSQL.
- **Show menu bar icon** adds quick sync, update and quit actions. **Start at login** uses macOS login items; approval may be needed under System Settings → General → Login Items. Unsigned previews may require adding the app there manually.
- Data lives in `~/Library/Application Support/Unified Achievement Manager`. File → Open Data Folder and Open Log File reveal it. Deleting the app preserves data.
- Backups contain physical PostgreSQL files. Treat them as same-platform, same-architecture backups; copying a Windows backup or data folder to a Mac is not a supported migration. To move between Windows and a Mac, use **File → Export for Another Computer…** and **File → Import from Another Computer…** (see [operations.md](operations.md#backing-up-and-moving-to-a-new-pc)).

## Validation and release gates

PR CI mounts each native DMG, copies the packaged app to a scratch installation, boots a fresh private PostgreSQL database and dashboard, checks close/Dock activation, quits cleanly, relaunches with the same database identity, then removes the app and verifies data remains. Tests use isolated empty data with no platform logins. Existing server, desktop and Windows installer checks must also pass.

Before publishing a Mac release:

- Obtain Developer ID signing and notarization; sign bundled PostgreSQL executables/libraries as well as Electron helpers, and validate Gatekeeper on downloaded packages.
- Test the oldest supported macOS version on real Apple Silicon and Intel hardware; CI runs macOS 15 and does not establish the minimum supported OS.
- Test Steam sign-in, PSN/GOG token persistence, other platform syncs, notifications, Discord, native dialogs and same-architecture backup/restore and Windows-to-Mac export/import on real Macs.
- Check menu-bar appearance, keyboard shortcuts, VoiceOver, Dock behavior, login-item approval, clean quit and crash recovery.
- Validate signed auto-update, architecture selection and `latest-mac.yml` metadata before enabling it.
- Follow the release checklist and obtain explicit permission for a release/tag.
