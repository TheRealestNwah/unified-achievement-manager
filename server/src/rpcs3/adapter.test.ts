import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ticks, writeGameFolder } from "./fixtures.test-support";
import { rpcs3Adapter } from "./adapter";
import type { LinkedAccount } from "../sync/platformAdapter";

// The RPCS3 adapter against synthetic trophy folders (see #522). What the
// pipeline then does with its answers is covered by the pipeline's own tests.
describe("RPCS3 adapter", () => {
    let root: string;
    let trophyDir: string;
    const account = (localFolder: string | null): LinkedAccount => ({
        platformAccountId: "00000001",
        accessToken: null,
        refreshToken: null,
        localFolder,
    });

    beforeAll(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "uam-rpcs3-adapter-"));
        trophyDir = path.join(root, "dev_hdd0", "home", "00000001", "trophy");
    });

    afterAll(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    it("asks for a folder when none is set", async () => {
        await expect(rpcs3Adapter.connect(account(null))).rejects.toThrow("Pick your RPCS3 folder in Settings.");
    });

    it("owns every trophy folder and reads each one's trophies with native tiers, unlocks and icons", async () => {
        const at = new Date("2025-06-01T12:00:00.000Z");
        writeGameFolder(trophyDir, "NPWR11111_00", [{ id: 0, unlocked: false }, { id: 1, unlocked: true, at: ticks(at) }, { id: 2, unlocked: true }], ["ICON0.PNG", "TROP001.PNG"]);
        // Unreadable: still owned, skipped when read.
        fs.mkdirSync(path.join(trophyDir, "NPWR22222_00"), { recursive: true });

        const session = await rpcs3Adapter.connect(account(root));
        const owned = await session.listOwnedGames();
        expect(owned.map((g) => g.platformGameId).sort()).toEqual(["NPWR11111_00", "NPWR22222_00"]);

        const game = (id: string) => owned.find((g) => g.platformGameId === id)!;

        expect(await session.fetchAchievementList(game("NPWR22222_00"))).toMatchObject({ kind: "skip" });

        const list = await session.fetchAchievementList(game("NPWR11111_00"));
        expect(list).toMatchObject({ kind: "achievements", title: "Test & Game", coverImageUrl: "/rpcs3-icons/NPWR11111_00/ICON0.PNG" });
        if (list.kind !== "achievements") throw new Error("expected achievements");
        expect(list.achievements.map((a) => ({ id: a.id, tier: a.nativeTier, icon: a.iconUrl, unlocked: a.unlocked, at: a.unlockedAt }))).toEqual([
            { id: "0", tier: { tier: "platinum", tierSource: "psn_native" }, icon: undefined, unlocked: false, at: null },
            { id: "1", tier: { tier: "bronze", tierSource: "psn_native" }, icon: "/rpcs3-icons/NPWR11111_00/TROP001.PNG", unlocked: true, at },
            // Unlocked with no date is still unlocked.
            { id: "2", tier: { tier: "gold", tierSource: "psn_native" }, icon: undefined, unlocked: true, at: null },
        ]);
    });
});
