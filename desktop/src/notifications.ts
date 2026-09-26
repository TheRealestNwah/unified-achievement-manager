import { BrowserWindow, Notification } from "electron";
import { showWindow } from "./tray";

// Native notifications for unlocks a sync records while the window isn't in
// front - mostly the background scheduler's syncs (see #250). Polls the local
// /api/setup/new-unlocks feed; a platinum or level-up gets its own
// notification, everything else is summed into one so a big first sync
// doesn't produce hundreds.

interface NewUnlocksFeed {
    total: number;
    unlocks: { name: string; tier: string; game_title: string; platform_id: string }[];
    platinums: { name: string; game_title: string }[];
    level: number | null;
    cursor: string;
}

const POLL_INTERVAL_MS = 20_000;
const MAX_PLATINUM_NOTIFICATIONS = 3;

let pollTimer: ReturnType<typeof setInterval> | null = null;

async function fetchFeed(serverUrl: string, since: string): Promise<NewUnlocksFeed | null> {
    try {
        const res = await fetch(`${serverUrl}/api/setup/new-unlocks?since=${encodeURIComponent(since)}`);
        return res.ok ? ((await res.json()) as NewUnlocksFeed) : null;
    } catch {
        return null;
    }
}

function notify(title: string, body: string, getWindow: () => BrowserWindow | null): void {
    if (!Notification.isSupported()) return;
    const notification = new Notification({ title, body, silent: false });
    notification.on("click", () => showWindow(getWindow()));
    notification.show();
}

// What a batch of new unlocks should say, split out so it's easy to follow:
// platinums and a level-up first, then one summary of the rest.
export function describeFeed(feed: NewUnlocksFeed, previousLevel: number | null): { title: string; body: string }[] {
    const messages: { title: string; body: string }[] = [];
    for (const p of feed.platinums.slice(0, MAX_PLATINUM_NOTIFICATIONS)) {
        messages.push({ title: "Platinum unlocked!", body: `${p.name} — ${p.game_title}` });
    }
    if (previousLevel !== null && feed.level !== null && feed.level > previousLevel) {
        messages.push({ title: `Level ${feed.level} reached`, body: "Nice work." });
    }
    const others = feed.total - feed.platinums.length;
    if (others === 1) {
        const single = feed.unlocks.find((u) => u.tier !== "platinum");
        if (single) messages.push({ title: "Achievement unlocked", body: `${single.name} — ${single.game_title}` });
    } else if (others > 1) {
        const games = [...new Set(feed.unlocks.map((u) => u.game_title))];
        const gameList = games.length > 2 ? `${games.slice(0, 2).join(", ")} and more` : games.join(" and ");
        messages.push({ title: `${others} new achievements`, body: gameList ? `Including ${gameList}.` : "Synced in the background." });
    }
    return messages;
}

export function startUnlockNotifications(
    serverUrl: string,
    getWindow: () => BrowserWindow | null,
    isEnabled: () => boolean
): void {
    // Anything already recorded before launch is old news.
    let cursor = new Date().toISOString();
    let level: number | null = null;
    let polling = false;

    const poll = async () => {
        if (polling) return;
        polling = true;
        try {
            const feed = await fetchFeed(serverUrl, cursor);
            if (!feed) return;
            cursor = feed.cursor;
            const previousLevel = level;
            level = feed.level;
            if (feed.total === 0 || !isEnabled()) return;
            // Someone looking at the app already sees the new unlocks.
            const window = getWindow();
            if (window && window.isVisible() && window.isFocused() && !window.isMinimized()) return;
            for (const { title, body } of describeFeed(feed, previousLevel)) notify(title, body, getWindow);
        } finally {
            polling = false;
        }
    };

    void poll();
    pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);
}

export function stopUnlockNotifications(): void {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
}
