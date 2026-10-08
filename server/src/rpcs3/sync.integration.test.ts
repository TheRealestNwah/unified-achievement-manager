import fs from "fs";
import os from "os";
import path from "path";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { ticks, writeGameFolder } from "./fixtures.test-support";

const integrationEnabled = process.env.INTEGRATION_TESTS === "true";
const integration = integrationEnabled ? describe : describe.skip;

integration("RPCS3 sync (#522)", () => {
    let pool: import("pg").Pool;
    let syncRpcs3Account: typeof import("./sync").syncRpcs3Account;
    let root: string;
    let trophyDir: string;
    let accountId: string;

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for integration tests");
        ({ pool } = await import("../db"));
        ({ syncRpcs3Account } = await import("./sync"));
        const { applySchema } = await import("../db/migrate");
        await applySchema();
        await pool.query("truncate table users, games, canonical_achievements cascade");
        const userId = (await pool.query("insert into users (username) values ('rpcs3-user') returning id")).rows[0].id;
        accountId = (
            await pool.query(
                `insert into user_platform_accounts (user_id, platform_id, platform_account_id, display_name, local_folder)
                 values ($1, 'rpcs3', '00000001', 'User', $2) returning id`,
                [userId, "unused"]
            )
        ).rows[0].id;

        root = fs.mkdtempSync(path.join(os.tmpdir(), "uam-rpcs3-sync-"));
        trophyDir = path.join(root, "dev_hdd0", "home", "00000001", "trophy");
    });

    afterAll(async () => {
        if (root) fs.rmSync(root, { recursive: true, force: true });
        await pool?.end();
    });

    it("imports each trophy folder as an RPCS3 game with native tiers, unlocks and icons", async () => {
        const at = new Date("2025-06-01T12:00:00.000Z");
        writeGameFolder(trophyDir, "NPWR11111_00", [{ id: 0, unlocked: false }, { id: 1, unlocked: true, at: ticks(at) }, { id: 2, unlocked: true }], ["ICON0.PNG", "TROP001.PNG"]);
        // Unreadable: skipped without failing the sync.
        fs.mkdirSync(path.join(trophyDir, "NPWR22222_00"), { recursive: true });

        const summary = await syncRpcs3Account(accountId, root, "00000001");
        expect(summary).toMatchObject({ gamesProcessed: 1, achievementsUnlocked: 2 });

        const game = await pool.query(
            `select g.title, g.cover_image_url from games g
             join game_platform_links gpl on gpl.game_id = g.id
             where gpl.platform_id = 'rpcs3' and gpl.platform_game_id = 'NPWR11111_00'`
        );
        expect(game.rows[0]).toEqual({ title: "Test & Game", cover_image_url: "/rpcs3-icons/NPWR11111_00/ICON0.PNG" });

        const trophies = await pool.query(
            `select apl.platform_achievement_id as id, ca.tier, ca.tier_source, ca.icon_url, uau.unlocked_at
             from achievement_platform_links apl
             join canonical_achievements ca on ca.id = apl.canonical_achievement_id
             left join user_achievement_unlocks uau on uau.achievement_platform_link_id = apl.id
             where apl.platform_id = 'rpcs3'
             order by apl.platform_achievement_id`
        );
        expect(trophies.rows).toEqual([
            { id: "0", tier: "platinum", tier_source: "psn_native", icon_url: null, unlocked_at: null },
            { id: "1", tier: "bronze", tier_source: "psn_native", icon_url: "/rpcs3-icons/NPWR11111_00/TROP001.PNG", unlocked_at: at },
            { id: "2", tier: "gold", tier_source: "psn_native", icon_url: null, unlocked_at: null },
        ]);
        // Unlocked with no date is still unlocked.
        const unlocked = await pool.query(
            "select count(*)::int as n from user_achievement_unlocks where user_platform_account_id = $1",
            [accountId]
        );
        expect(unlocked.rows[0].n).toBe(2);
    });

    it("revokes an unlock RPCS3 no longer has", async () => {
        writeGameFolder(trophyDir, "NPWR11111_00", [{ id: 0, unlocked: false }, { id: 1, unlocked: false }, { id: 2, unlocked: true }]);
        const summary = await syncRpcs3Account(accountId, root, "00000001");
        expect(summary).toMatchObject({ achievementsUnlocked: 0, achievementsRevoked: 1 });
    });
});
