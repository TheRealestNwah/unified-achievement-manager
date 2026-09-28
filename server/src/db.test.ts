import { describe, expect, it, vi } from "vitest";
import { pool } from "./db";

describe("pool", () => {
    it("survives an idle connection dropping instead of crashing the app (#419)", () => {
        const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
        expect(() => pool.emit("error", new Error("read ECONNRESET"))).not.toThrow();
        expect(log).toHaveBeenCalledWith("A database connection dropped:", "read ECONNRESET");
        log.mockRestore();
    });
});
