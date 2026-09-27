import { beforeAll, afterAll, describe, expect, it } from "vitest";

const integrationEnabled = process.env.INTEGRATION_TESTS === "true";
const integration = integrationEnabled ? describe : describe.skip;

integration("schema.sql repair of achievements stranded on another game (#363)", () => {
    let pool: import("pg").Pool;
    let canonicalStore: typeof import("../sync/canonicalStore");
    let migrate: typeof import("./migrate");

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for integration tests");
        ({ pool } = await import("../db"));
        canonicalStore = await import("../sync/canonicalStore");
        migrate = await import("./migrate");
        await pool.query("truncate table users, games, canonical_achievements cascade");
    });

    afterAll(async () => {
        await pool?.end();
    });

    const gameOf = async (linkId: string) =>
        (
            await pool.query(
                `select ca.id, ca.game_id from achievement_platform_links apl
                 join canonical_achievements ca on ca.id = apl.canonical_achievement_id where apl.id = $1`,
                [linkId]
            )
        ).rows[0];

    it("gives the remake's links their own achievement on the remake and leaves the RetroAchievements one", async () => {
        const remake = await canonicalStore.getOrCreateCanonicalGame("steam", "883710", "RESIDENT EVIL 2");
        await canonicalStore.getOrCreateCanonicalGame("psn", "NPWR15179_00", "RESIDENT EVIL 2");
        await pool.query("update game_platform_links set game_id = $1 where platform_game_id = 'NPWR15179_00'", [remake]);
        const classic = await canonicalStore.getOrCreateCanonicalGame("retroachievements", "10077", "Resident Evil 2");

        // The stranded shape: one canonical row on the classic game carrying
        // the remake's Steam and PSN links alongside the RA one.
        const ra = await canonicalStore.getOrCreateAchievementLink(classic, "retroachievements", "10077", "62927", "Grim Reaper", undefined, 5);
        const steam = await canonicalStore.getOrCreateAchievementLink(remake, "steam", "883710", "G", "Grim Reaper", undefined, 5);
        const psn = await canonicalStore.getOrCreateAchievementLink(remake, "psn", "NPWR15179_00", "41", "Grim Reaper", undefined, 5, {
            tier: "bronze",
            tierSource: "psn_native",
        });
        const stranded = (await gameOf(ra)).id;
        await pool.query("update achievement_platform_links set canonical_achievement_id = $1 where id = any($2)", [
            stranded,
            [steam, psn],
        ]);
        // A remake-only achievement that ended up there too, with nothing left behind.
        const moved = await canonicalStore.getOrCreateAchievementLink(remake, "steam", "883710", "L", "Leon", undefined, 5);
        const movedId = (await gameOf(moved)).id;
        await pool.query("update canonical_achievements set game_id = $1 where id = $2", [classic, movedId]);

        await migrate.applySchema();
        await migrate.applySchema(); // idempotent

        expect(await gameOf(ra)).toEqual({ id: stranded, game_id: classic });
        const steamNow = await gameOf(steam);
        expect(steamNow.game_id).toBe(remake);
        expect(steamNow.id).not.toBe(stranded);
        expect(await gameOf(psn)).toEqual(steamNow);
        expect(await gameOf(moved)).toEqual({ id: movedId, game_id: remake });
    });
});
