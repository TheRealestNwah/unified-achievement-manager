import { describe, expect, it } from "vitest";
import { exportFileName, toCsv } from "./exportFile";

describe("exportFileName", () => {
    it("includes the local date, zero-padded (#290)", () => {
        expect(exportFileName("csv", new Date(2026, 0, 5, 23, 30))).toBe("unified-achievement-manager-export-2026-01-05.csv");
        expect(exportFileName("json", new Date(2026, 10, 25))).toBe("unified-achievement-manager-export-2026-11-25.json");
    });
});

describe("toCsv", () => {
    it("writes dates as ISO 8601, like the JSON export (#335)", () => {
        const csv = toCsv([{ name: "A", unlocked_at: new Date("2026-09-10T00:00:00Z") }]);
        expect(csv).toBe("name,unlocked_at\nA,2026-09-10T00:00:00.000Z");
    });

    it("leaves nulls empty and quotes commas, quotes, and newlines", () => {
        const csv = toCsv([{ name: 'Say "hi", then\nleave', unlocked_at: null }]);
        expect(csv).toBe('name,unlocked_at\n"Say ""hi"", then\nleave",');
    });

    it("returns an empty string for no rows", () => {
        expect(toCsv([])).toBe("");
    });
});
