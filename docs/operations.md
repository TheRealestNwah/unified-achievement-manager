# Your data, backups, and troubleshooting

## Where everything lives

All of Unified Achievement Manager's data is in one folder: `%APPDATA%\Unified Achievement Manager` (usually `C:\Users\<you>\AppData\Roaming\Unified Achievement Manager`). **File → Open Data Folder** opens it.

| Path | What it is |
|---|---|
| `postgres\` | The app's private PostgreSQL database: your library, unlocks, scores, and encrypted platform credentials |
| `secrets.json` | The key that encrypts your platform credentials, plus the session secret. Without it, stored credentials can't be decrypted |
| `database.json` | The password for the private database |
| `app.json` | The local port the app last ran on, reused so your display preferences (theme, hidden dashboard sections, collapsed sidebar and platform sections) stick between launches |
| `window-state.json` | The window's last size, position, and maximized state |
| `uploads\` | Cover art and icons you uploaded |
| `logs\main.log`, `postgres.log` | App and database logs |

The program itself is installed separately (by default in `%LOCALAPPDATA%\Programs\Unified Achievement Manager`). Uninstalling removes the program and **keeps** the data folder.

## Backing up and moving to a new PC

**File → Back Up…** saves everything above except the logs into one `.tar.gz` file (Documents by default). The app briefly stops its database so the copy is consistent, then restarts. The backup contains your platform logins and the key that decrypts them, so keep it somewhere private.

**File → Restore from Backup…** replaces your data with a backup and restarts the app. It checks the file first, and your current data isn't deleted: it's moved into a `before restore <date>` folder inside the data folder. Delete that folder once you're happy with the restore.

To move to another PC: back up on the old one, install Unified Achievement Manager on the new one, and use **File → Restore from Backup…** there.

You can also back up by hand: quit the app (closing the window quits it, unless **Keep running in the tray** is on in Settings; then right-click the tray icon and choose **Quit**), and copy the files listed above. Restore by quitting the app and putting them back. `secrets.json` and `postgres\` only work together, and a copy taken while the app is running may not be consistent.

**Settings → Export** gives you a portable JSON or CSV of every achievement in your library and your unlocks too, but it isn't something the app can import back.

## Removing everything

Delete your profile from **Settings → Profile → Delete profile**, or simply uninstall Unified Achievement Manager and then delete the `%APPDATA%\Unified Achievement Manager` folder. Platform credentials you gave the app (Xbox/OpenXBL key, PSN token, RetroAchievements key, GOG login) can also be revoked on those platforms' own sites.

## Troubleshooting

- **"Windows protected your PC" when installing:** the installer isn't code-signed yet. Click **More info → Run anyway**.
- **The app won't start:** it shows an error with the log file's location. `logs\main.log` has the details and `postgres.log` has database errors. Include both when reporting a problem, after checking them for anything personal.
- **It says it's already running:** only one copy runs at a time, and starting it again brings the existing window forward. If no window is visible, end any leftover `Unified Achievement Manager.exe` in Task Manager.
- **After a crash:** a database left running by a crash is stopped cleanly the next time the app starts. The installer and uninstaller also stop it, so updates and uninstalling aren't blocked by locked files.
- **"The app's database stopped unexpectedly":** the app's own PostgreSQL (`postgres.exe`) was ended, for example from Task Manager, or crashed. Choose **Restart** to start it again. Your data is safe. If it keeps happening, `postgres.log` in the data folder says why.
- **Connecting Steam or its sync fails:** check the Steam Web API key under **Settings → API keys → Steam Web API**. Steam rejects mistyped keys, and a key revoked on Steam's site stops working here too.
- **PSN or GOG stops syncing:** their logins expire after a while, and Settings says so. Use **Update login…** on that platform with a fresh NPSSO token or GOG login code. Your library stays as it is.
- **RPCS3 says its folder doesn't look like RPCS3's:** pick the folder `rpcs3.exe` is in, which has `dev_hdd0` inside it. If you moved `dev_hdd0` in RPCS3's settings, pick that `dev_hdd0` folder instead. After moving RPCS3, use **Change folder…** on its row in Settings; your library stays as it is.
- **An RPCS3 game's trophies are missing:** RPCS3 writes a game's trophy files the first time the game starts, and trophies synced to RPCN from another PC arrive when you start the game with RPCN on. Start the game in RPCS3, then sync.
- **An achievement says "Unlocked, date unknown":** the platform didn't say when it was earned, which is common for older Xbox 360 achievements and for trophies earned in older RPCS3 versions. It still counts toward your score, but it's left out of Recent activity and the date-based stats rather than showing up as brand new.
