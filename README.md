# Unified Achievement Manager

A Windows desktop app that pulls your Steam, Xbox, PlayStation, RetroAchievements, and GOG achievements into one place, with a unified score and level modeled on PlayStation's trophy system. Everything runs on your own computer. There's no server to set up, no account with us, and nothing leaves your PC except the requests to the platforms you connect.

- Every achievement gets a PSN-style tier (Bronze/Silver/Gold/Platinum). If a game exists on PlayStation, its native trophy tier wins, even for the Steam or Xbox version of the same achievement. Otherwise the tier comes from global unlock rarity.
- One combined score and level across all connected platforms, following a PSN-like leveling curve.
- A dashboard grouped per game and per platform, so multiple platinums or 100%s on the same game each show up.

## Install

1. Download `Unified-Achievement-Manager-Setup-<version>.exe` from the [Releases page](https://github.com/TheRealestNwah/unified-achievement-manager/releases).
2. Run it. It installs for your Windows user only and doesn't need administrator rights.
3. The 1.0 installer isn't code-signed yet, so Windows SmartScreen may say it "protected your PC" from an unrecognized app. Click **More info**, then **Run anyway**.

Windows 10/11, 64-bit. The installer is about 135 MB because it bundles its own private copy of PostgreSQL, which only the app uses.

## First run

1. **Steam Web API key.** On first launch the app asks for your own free key. Open [steamcommunity.com/dev/apikey](https://steamcommunity.com/dev/apikey), enter `localhost` as the domain name, and paste the key it gives you. The app checks the key with Steam and stores it encrypted on your computer. You can change it later from **Platforms → Steam Web API key**.
2. **Sign in with Steam.** Steam's own sign-in page opens inside the app. Your Steam account becomes your identity in the app.
3. Click **Sync** to pull your Steam library, then connect other platforms.

## Connecting platforms

- **Xbox:** get a personal API key from [xbl.io/dashboard](https://xbl.io/dashboard) (sign in with your Microsoft account there first) and paste it in.
- **PlayStation:** log into [playstation.com](https://www.playstation.com) in your browser, then in the same browser visit https://ca.account.sony.com/api/v1/ssocookie and paste the `npsso` value it shows. Treat that token like a password, since it grants full account access.
- **RetroAchievements:** get a personal Web API key from your [account settings page](https://retroachievements.org/settings) and paste it in with your username.
- **GOG:** click **Log in at GOG**, sign in in your browser, then copy the `code` value out of the address GOG redirects you to and paste it in. Codes are single-use and expire quickly, so paste it straight away.

Links like these open in your normal web browser. Only Steam sign-in happens inside the app.

## Using it

- **Sync:** pulls each platform's library and unlocks and recomputes your score. While the app is open it also re-syncs every linked platform automatically every 6 hours. Turn on **Settings → Desktop app → Keep running in the tray** to keep that going after you close the window, and **Start with Windows** to have it start in the tray when you sign in. When a sync finds new achievements while the app isn't in front, a Windows notification says so (turn it off under **Settings → Desktop app → Unlock notifications**).
- **Find matches:** links the same real-world game and achievement across platforms so they share one tier, with PSN's own tier always winning. Your score isn't collapsed: unlocking the same achievement on two platforms still counts both.
- **Review:** high-confidence matches merge automatically. Anything uncertain (achievement matches, game merges, and possible bad merges) waits on the **Review** page in the sidebar, with a count of what's waiting, for you to confirm or reject.
- **Link games:** automatic matching only merges exact titles, so it misses cases like "Skyrim" on PSN vs "The Elder Scrolls V: Skyrim" on Steam. Click **Link games**, click the game whose title you want to keep, then click the duplicate.
- **Cover art and icons:** click a game's cover or an achievement's icon to paste an image URL or upload your own (PNG, JPEG, WebP, or GIF, up to 5 MB).
- **Export:** download your full unlock history as JSON or CSV from **Settings → Export**.
- **Disconnect:** Xbox, PSN, RetroAchievements, and GOG can each be unlinked, which removes that platform's synced games and achievements. Steam can't be disconnected because it's how you sign in.
- **Delete account:** permanently removes your account and everything linked to it after you type `DELETE` to confirm.

## Your data

Everything is stored in `%APPDATA%\Unified Achievement Manager` (open it from **File → Open Data Folder**). Uninstalling keeps it, so reinstalling picks up where you left off. See [docs/operations.md](docs/operations.md) for backups, moving to a new PC, removing everything, and troubleshooting, and [docs/privacy.md](docs/privacy.md) for exactly what is stored and sent where.

## Status

See [ROADMAP.md](ROADMAP.md). Steam, Xbox, PSN, RetroAchievements, and GOG all work end to end.

## Development

See [docs/development.md](docs/development.md) for running from source, building the installer, the tests, and the HTTP API. How tiers, matching, and scoring work is in [docs/data-model.md](docs/data-model.md).
