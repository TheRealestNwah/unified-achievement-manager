import fs from "fs";
import path from "path";
import { BrowserWindow, Rectangle, screen } from "electron";

// Remembers the main window's size, position, and maximized state between
// launches (see #251), in window-state.json in the data folder.

interface SavedWindowState {
    bounds: Rectangle;
    maximized: boolean;
}

const DEFAULT_SIZE = { width: 1280, height: 860 };

function stateFile(dataDir: string): string {
    return path.join(dataDir, "window-state.json");
}

function isRectangle(value: unknown): value is Rectangle {
    const r = value as Partial<Rectangle> | null;
    return [r?.x, r?.y, r?.width, r?.height].every((n) => Number.isFinite(n));
}

// A saved position is only reused while enough of the window would still be
// on a connected display - otherwise (a monitor unplugged since) it opens
// centered on the primary display at the saved size.
function isVisibleOnSomeDisplay(bounds: Rectangle): boolean {
    const MIN_VISIBLE = 100;
    return screen.getAllDisplays().some(({ workArea }) => {
        const overlapWidth = Math.min(bounds.x + bounds.width, workArea.x + workArea.width) - Math.max(bounds.x, workArea.x);
        const overlapHeight = Math.min(bounds.y + bounds.height, workArea.y + workArea.height) - Math.max(bounds.y, workArea.y);
        return overlapWidth >= MIN_VISIBLE && overlapHeight >= MIN_VISIBLE;
    });
}

export function loadWindowState(dataDir: string): { bounds: Partial<Rectangle>; maximized: boolean } {
    try {
        const saved = JSON.parse(fs.readFileSync(stateFile(dataDir), "utf8")) as Partial<SavedWindowState>;
        if (!isRectangle(saved.bounds)) throw new Error("no saved bounds");
        const { x, y, width, height } = saved.bounds;
        const bounds = isVisibleOnSomeDisplay(saved.bounds) ? { x, y, width, height } : { width, height };
        return { bounds, maximized: saved.maximized === true };
    } catch {
        return { bounds: { ...DEFAULT_SIZE }, maximized: false };
    }
}

// Saves on every move/resize (debounced) and on close, using the normal
// (un-maximized) bounds so restoring from maximized goes back to them.
export function trackWindowState(window: BrowserWindow, dataDir: string): void {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const save = () => {
        if (window.isDestroyed() || window.isMinimized()) return;
        const state: SavedWindowState = { bounds: window.getNormalBounds(), maximized: window.isMaximized() };
        try {
            fs.writeFileSync(stateFile(dataDir), JSON.stringify(state, null, 2));
        } catch (err) {
            console.warn("Couldn't save the window position:", err);
        }
    };
    const scheduleSave = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(save, 500);
    };
    window.on("resize", scheduleSave);
    window.on("move", scheduleSave);
    window.on("maximize", scheduleSave);
    window.on("unmaximize", scheduleSave);
    window.on("close", () => {
        if (timer) clearTimeout(timer);
        save();
    });
}
