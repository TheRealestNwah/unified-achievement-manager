import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { parseTropconf, parseTropusr, readTrophySet, ticksToDate, TrophyFileError } from "./trophyFiles";
import { buildTropusr, ticks, TROPCONF } from "./fixtures.test-support";

describe("TROPUSR.DAT", () => {
    it("reads unlock state and microsecond PS3 ticks as dates", () => {
        const at = new Date("2026-04-09T15:55:29.973Z");
        const unlocks = parseTropusr(
            buildTropusr([
                { id: 0, unlocked: false },
                { id: 1, unlocked: true, at: ticks(at) },
                { id: 2, unlocked: true },
            ])
        );
        expect(unlocks.get(0)).toEqual({ unlocked: false, unlockedAt: null });
        expect(unlocks.get(1)).toEqual({ unlocked: true, unlockedAt: at });
        // RPCS3 leaves some unlocks without a time.
        expect(unlocks.get(2)).toEqual({ unlocked: true, unlockedAt: null });
    });

    it("decodes a timestamp from a real file", () => {
        expect(ticksToDate(0x00e30f080ae0baean)?.toISOString()).toBe("2026-04-09T15:55:29.973Z");
    });

    it("rejects files that aren't RPCS3 trophy data or are cut short", () => {
        expect(() => parseTropusr(Buffer.from("not a trophy file at all, nope, not even close....."))).toThrow(TrophyFileError);
        const full = buildTropusr([{ id: 0, unlocked: true }]);
        expect(() => parseTropusr(full.subarray(0, full.length - 8))).toThrow(TrophyFileError);
    });
});

describe("TROPCONF.SFM", () => {
    it("reads the title and each trophy's name, detail, grade and hidden flag", () => {
        const config = parseTropconf(TROPCONF);
        expect(config.title).toBe("Test & Game");
        expect(config.trophies).toEqual([
            { id: 0, name: "All Done", detail: "Get every trophy", grade: "platinum", hidden: false },
            { id: 1, name: 'First "Steps"', detail: "Finish the tutorial", grade: "bronze", hidden: true },
            { id: 2, name: "Hard", detail: "Beat it on hard", grade: "gold", hidden: false },
        ]);
    });

    it("rejects files that aren't a trophy list", () => {
        expect(() => parseTropconf("<html></html>")).toThrow(TrophyFileError);
    });
});

describe("readTrophySet", () => {
    let dir: string | undefined;
    afterEach(() => {
        if (dir) fs.rmSync(dir, { recursive: true, force: true });
        dir = undefined;
    });

    it("combines both files and finds the icons that exist", async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "uam-rpcs3-"));
        const folder = path.join(dir, "NPWR99999_00");
        fs.mkdirSync(folder);
        const at = new Date("2025-01-02T03:04:05.000Z");
        fs.writeFileSync(path.join(folder, "TROPUSR.DAT"), buildTropusr([{ id: 0, unlocked: false }, { id: 1, unlocked: true, at: ticks(at) }, { id: 2, unlocked: false }]));
        fs.writeFileSync(path.join(folder, "TROPCONF.SFM"), TROPCONF);
        fs.writeFileSync(path.join(folder, "ICON0.PNG"), "");
        fs.writeFileSync(path.join(folder, "TROP001.PNG"), "");

        const set = await readTrophySet(folder);
        expect(set).toMatchObject({ communicationId: "NPWR99999_00", title: "Test & Game", iconFile: "ICON0.PNG" });
        expect(set.trophies.map((t) => [t.id, t.unlocked, t.unlockedAt, t.iconFile])).toEqual([
            [0, false, null, null],
            [1, true, at, "TROP001.PNG"],
            [2, false, null, null],
        ]);
    });
});
