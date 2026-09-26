import { describe, expect, it } from "vitest";
import { exportFileName } from "./exportFile";

describe("exportFileName", () => {
    it("includes the local date, zero-padded (#290)", () => {
        expect(exportFileName("csv", new Date(2026, 0, 5, 23, 30))).toBe("unified-achievement-manager-export-2026-01-05.csv");
        expect(exportFileName("json", new Date(2026, 10, 25))).toBe("unified-achievement-manager-export-2026-11-25.json");
    });
});
