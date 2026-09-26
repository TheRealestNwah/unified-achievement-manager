# Your data, backups, and troubleshooting

## Where everything lives

All of Unified Achievement Manager's data is in one folder: `%APPDATA%\Unified Achievement Manager` (usually `C:\Users\<you>\AppData\Roaming\Unified Achievement Manager`). **File → Open Data Folder** opens it.

| Path | What it is |
|---|---|
| `postgres\` | The app's private PostgreSQL database: your library, unlocks, scores, and encrypted platform credentials |
| `secrets.json` | The key that encrypts your platform credentials, plus the session secret. Without it, stored credentials can't be decrypted |
| `database.json` | The password for the private database |
| `app.json` | The local port the app last ran on, reused so your display preferences (theme, hidden sections) stick between launches |
| `uploads\` | Cover art and icons you uploaded |
| `logs\main.log`, `postgres.log` | App and database logs |

The program itself is installed separately (by default in `%LOCALAPPDATA%\Programs\Unified Achievement Manager`). Uninstalling removes the program and **keeps** the data folder.

## Backing up and moving to a new PC

1. Quit Unified Achievement Manager (closing the window quits it).
2. Copy the whole `%APPDATA%\Unified Achievement Manager` folder somewhere safe.

To restore, or to move to another PC: install Unified Achievement Manager, don't launch it (or quit it), replace `%APPDATA%\Unified Achievement Manager` with your copy, and start the app. Always copy the folder as a whole. `secrets.json` and `postgres\` only work together, and a copy taken while the app is running may not be consistent.

**Settings → Export** gives you a portable JSON or CSV of your unlock history too, but it isn't something the app can import back.

## Removing everything

Delete your account from the dashboard (**Delete account**), or simply uninstall Unified Achievement Manager and then delete the `%APPDATA%\Unified Achievement Manager` folder. Platform credentials you gave the app (Xbox/OpenXBL key, PSN token, RetroAchievements key, GOG login) can also be revoked on those platforms' own sites.

## Troubleshooting

- **"Windows protected your PC" when installing:** the 1.0 installer isn't code-signed yet. Click **More info → Run anyway**.
- **The app won't start:** it shows an error with the log file's location. `logs\main.log` has the details and `postgres.log` has database errors. Include both when reporting a problem, after checking them for anything personal.
- **It says it's already running:** only one copy runs at a time, and starting it again brings the existing window forward. If no window is visible, end any leftover `Unified Achievement Manager.exe` in Task Manager.
- **After a crash:** a database left running by a crash is stopped cleanly the next time the app starts. The installer and uninstaller also stop it, so updates and uninstalling aren't blocked by locked files.
- **Steam sign-in or sync fails right after setup:** check the Steam Web API key under **Platforms → Steam Web API key**. Steam rejects mistyped keys, and a key revoked on Steam's site stops working here too.
- **PSN or GOG stops syncing:** their tokens expire. Disconnect and reconnect that platform with a fresh token or code.

## Running as a classic server

The server can still run against an external PostgreSQL with a `.env` (see [development.md](development.md)). In that mode: keep `SESSION_SECRET` and `CREDENTIAL_ENCRYPTION_KEY` stable across deploys, run `npm run db:migrate` before starting a new version (it's safe to re-run), wait for `GET /readyz` to return 200 before routing traffic, and send SIGTERM to drain. Back up with `pg_dump --format=custom` against the same `DATABASE_URL`, and store the encryption key separately from database backups.
