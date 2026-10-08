import { beforeAll, afterAll, describe, expect, it } from "vitest";

const integrationEnabled = process.env.INTEGRATION_TESTS === "true";
const integration = integrationEnabled ? describe : describe.skip;

integration("matching RPCS3 games with PSN (#523)", () => {
    let pool: import("pg").Pool;
    let canonicalStore: typeof import("../sync/canonicalStore");
    let gameMatcher: typeof import("./gameMatcher");
    let achievementMatcher: typeof import("./achievementMatcher");

    async function trophy(gameId: string, platformId: string, listId: string, trophyId: string, name: string) {
        return canonicalStore.getOrCreateAchievementLink(gameId, platformId, listId, trophyId, name, undefined, undefined, {
            tier: "bronze",
            tierSource: "psn_native",
        });
    }

    async function candidatesFor(gameId: string) {
        const result = await pool.query(
            "select reason, status from game_merge_candidates where game_a_id = $1 or game_b_id = $1 order by reason",
            [gameId]
        );
        return result.rows;
    }

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for integration tests");
        ({ pool } = await import("../db"));
        canonicalStore = await import("../sync/canonicalStore");
        gameMatcher = await import("./gameMatcher");
        achievementMatcher = await import("./achievementMatcher");
        const { applySchema } = await import("../db/migrate");
        await applySchema();
        await pool.query("truncate table users, games, canonical_achievements cascade");
    });

    afterAll(async () => {
        await pool?.end();
    });

    it("suggests an RPCS3 and PSN game with the same trophy list, even with different titles", async () => {
        const rpcs3 = await canonicalStore.getOrCreateCanonicalGame("rpcs3", "NPWR03485_00", "METAL GEAR SOLID 4");
        const psn = await canonicalStore.getOrCreateCanonicalGame("psn", "NPWR03485_00", "Metal Gear Solid 4: Guns of the Patriots", undefined, "PS3");

        await gameMatcher.matchGames();

        expect(await candidatesFor(rpcs3)).toEqual([{ reason: "same-trophy-list", status: "pending" }]);
        const games = await pool.query("select count(*)::int as n from games where id in ($1, $2)", [rpcs3, psn]);
        expect(games.rows[0].n).toBe(2);
    });

    it("sends an exact-title match with a non-PlayStation platform to review instead of merging", async () => {
        const rpcs3 = await canonicalStore.getOrCreateCanonicalGame("rpcs3", "NPWR00196_00", "PAIN");
        const steam = await canonicalStore.getOrCreateCanonicalGame("steam", "pain-steam", "PAIN");

        await gameMatcher.matchGames();

        expect(await candidatesFor(rpcs3)).toEqual([{ reason: "exact-title-legacy-platform", status: "pending" }]);
        const games = await pool.query("select count(*)::int as n from games where id in ($1, $2)", [rpcs3, steam]);
        expect(games.rows[0].n).toBe(2);
    });

    it("doesn't suggest splitting an RPCS3 game the user linked with another platform", async () => {
        const rpcs3 = await canonicalStore.getOrCreateCanonicalGame("rpcs3", "NPWR00117_00", "SUPER STARDUST HD");
        const steam = await canonicalStore.getOrCreateCanonicalGame("steam", "stardust-steam", "Super Stardust HD");
        await gameMatcher.mergeGames(steam, rpcs3);

        const { detectLegacySignalSplitCandidates } = await import("./legacySignalSplitDetector");
        await detectLegacySignalSplitCandidates();

        const split = await pool.query("select count(*)::int as n from game_split_candidates where game_id = $1", [steam]);
        expect(split.rows[0].n).toBe(0);
    });

    it("pairs the trophies of a merged RPCS3 and PSN game by ID, whatever their names", async () => {
        const rpcs3 = await canonicalStore.getOrCreateCanonicalGame("rpcs3", "NPWR02355_00", "NBA JAM: On Fire Edition");
        const psn = await canonicalStore.getOrCreateCanonicalGame("psn", "NPWR02355_00", "NBA JAM: On Fire Edition", undefined, "PS3");
        await trophy(rpcs3, "rpcs3", "NPWR02355_00", "1", "Boomshakalaka");
        await trophy(rpcs3, "rpcs3", "NPWR02355_00", "2", "En feu");
        await trophy(psn, "psn", "NPWR02355_00", "1", "Boomshakalaka");
        await trophy(psn, "psn", "NPWR02355_00", "2", "On Fire");

        await gameMatcher.mergeGames(psn, rpcs3);
        await achievementMatcher.matchAchievementsForGame(psn);

        const canonical = await pool.query(
            `select apl.platform_achievement_id as id, count(distinct ca.id)::int as canonical, count(*)::int as links
             from achievement_platform_links apl
             join canonical_achievements ca on ca.id = apl.canonical_achievement_id
             where ca.game_id = $1
             group by apl.platform_achievement_id
             order by apl.platform_achievement_id`,
            [psn]
        );
        expect(canonical.rows).toEqual([
            { id: "1", canonical: 1, links: 2 },
            { id: "2", canonical: 1, links: 2 },
        ]);
    });
});
