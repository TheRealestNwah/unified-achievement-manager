import fs from "fs";
import net from "net";
import path from "path";
import { findFreePort } from "./embeddedDatabase";

const APP_FILE = "app.json";

// The dashboard keeps per-viewer preferences (theme, collapsed sections,
// hidden dashboard sections) in localStorage, which is scoped per origin
// including the port. Reusing the same port every launch keeps that origin -
// and so those preferences - stable (see #234). A new port is only picked,
// and remembered, when the saved one is taken.
export function isPortFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.unref();
        server.once("error", () => resolve(false));
        server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
    });
}

function readSavedPort(filePath: string): number | null {
    try {
        const { port } = JSON.parse(fs.readFileSync(filePath, "utf8")) as { port?: unknown };
        return Number.isInteger(port) && (port as number) > 0 && (port as number) < 65536 ? (port as number) : null;
    } catch {
        return null;
    }
}

export async function resolveAppPort(dataDir: string): Promise<number> {
    const filePath = path.join(dataDir, APP_FILE);
    const saved = readSavedPort(filePath);
    if (saved !== null && (await isPortFree(saved))) return saved;

    const port = await findFreePort();
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ port }, null, 2));
    return port;
}
