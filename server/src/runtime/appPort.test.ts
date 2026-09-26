import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAppPort } from "./appPort";

let dataDir: string;

beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "uam-port-"));
});

afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
});

function occupy(port: number): Promise<net.Server> {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.listen(port, "127.0.0.1", () => resolve(server));
    });
}

describe("resolveAppPort", () => {
    it("remembers the port it picks and reuses it on the next launch", async () => {
        const first = await resolveAppPort(dataDir);
        expect(JSON.parse(fs.readFileSync(path.join(dataDir, "app.json"), "utf8"))).toEqual({ port: first });
        expect(await resolveAppPort(dataDir)).toBe(first);
    });

    it("picks and saves a new port when the saved one is taken", async () => {
        const first = await resolveAppPort(dataDir);
        const blocker = await occupy(first);
        try {
            const second = await resolveAppPort(dataDir);
            expect(second).not.toBe(first);
            expect(JSON.parse(fs.readFileSync(path.join(dataDir, "app.json"), "utf8"))).toEqual({ port: second });
        } finally {
            await new Promise((resolve) => blocker.close(resolve));
        }
    });

    it("ignores a malformed app.json", async () => {
        fs.writeFileSync(path.join(dataDir, "app.json"), "{not json");
        const port = await resolveAppPort(dataDir);
        expect(port).toBeGreaterThan(0);
    });
});
