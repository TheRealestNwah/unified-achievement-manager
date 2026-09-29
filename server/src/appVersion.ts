import fs from "fs";
import path from "path";

// The server's package.json version always matches the desktop app's (see
// docs/release-checklist.md), and it ships beside dist/ in the installed app,
// so the dashboard can show it without asking Electron (see #474).
export const APP_VERSION: string = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")).version;
