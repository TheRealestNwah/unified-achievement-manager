# Privacy and data handling

Unified Achievement Manager runs entirely on your computer. There's no Unified Achievement Manager server, account, analytics, telemetry, or advertising. This page describes what the app stores locally and which outside services it talks to. It's product documentation, not legal advice.

## What is stored, and where

Everything is kept in your Windows user's data folder, `%APPDATA%\Unified Achievement Manager` (see [operations.md](operations.md)):

- **Your profile:** the name you gave it and the app's generated ID for it. If you connect Steam, your Steam account ID and display name, returned by Steam's own sign-in page.
- **Library data:** for each linked platform, the account ID and display name, owned games, achievement definitions, unlock times, and the derived score and level. For RPCS3, the path to your RPCS3 folder.
- **Credentials:** your Steam Web API key, Xbox/OpenXBL key, PSN and GOG tokens, RetroAchievements key, and SteamGridDB key if you add one. These are encrypted with AES-256-GCM before they're written to the database. The encryption key is in `secrets.json` in the same folder. That keeps credentials unreadable in a copied database file on its own, but it doesn't protect them from someone who can already open your Windows account's files.
- **Sessions:** the dashboard's session is stored in the app's database. There's no sign-in: the app only answers requests from this computer, addressed to itself.
- **Your content:** cover art and achievement icons you add.
- **Logs:** app and database logs in the data folder. They aren't meant to contain credentials, but check them before sharing them with anyone.

The app's database and web server only accept connections from your own computer (`127.0.0.1`).

**RPCS3** is read from files on your computer rather than over the network: the app reads the trophy files in the RPCS3 folder you pick (each game's `TROPUSR.DAT`, `TROPCONF.SFM` and icons) and never changes them. It doesn't read RPCS3's settings, including your RPCN login, and doesn't contact RPCN.

## What is sent where

The app only contacts:

- **The platforms you connect** (Steam, OpenXBL for Xbox, PlayStation Network, RetroAchievements, GOG), using the credentials you gave it, to read your library and achievements. Connecting Steam happens on Steam's own sign-in page. The app never sees your platform passwords.
- **Image hosts** for game covers and achievement icons, which are loaded from each platform's CDN or from image URLs you paste.
- **SteamGridDB**, only when you use its cover picker. The app sends your SteamGridDB key and the game's Steam app ID or title to find covers, the picker loads thumbnails from SteamGridDB's servers, and the cover you pick is downloaded and kept on your computer.
- **GitHub**, to check for updates. The installed app asks this project's GitHub Releases page whether a newer version exists shortly after it starts and every 4 hours after that, and downloads the update from there when one does. The request carries nothing about you or your library, but GitHub sees your IP address like any web request. Turn off the background checks under **Settings → Desktop app → Automatic updates**. **Check now** next to it still checks when you ask.
- **Discord**, through **Discord Rich Presence**, which is on by default. While the app and the Discord app are both running, the app passes your level and XP to Discord on your computer (never over the network directly), and Discord shows them on your profile, where other people can see them. Turn it off under **Settings → Discord → Discord Rich Presence**.

Those requests are subject to each provider's own terms and privacy policies. The app sends nothing anywhere else.

## Deleting data

- **Disconnect** removes that platform's linked account and its synced ownership and unlock data.
- **Delete profile** removes your profile, sessions, linked accounts, unlocks, scores, and overrides, and deletes uploaded images. App-wide settings stay: the Steam Web API key and, if you added one, the SteamGridDB key. Remove the SteamGridDB key from its settings row.
- **Uninstalling** removes the program but keeps the data folder. Delete `%APPDATA%\Unified Achievement Manager` to remove everything.
- Credentials you issued (API keys, tokens) can also be revoked on each platform's own site.
