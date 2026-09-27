import { beforeAll, afterAll, describe, expect, it } from "vitest";

const integrationEnabled = process.env.INTEGRATION_TESTS === "true";
const integration = integrationEnabled ? describe : describe.skip;

integration("mergeAchievements keeps each user's icon override (#342)", () => {
    let pool: import("pg").Pool;
    let canonicalStore: typeof import("../sync/canonicalStore");
    let mergeAchievements: typeof import("./achievementMatcher").mergeAchievements;
    let userId: string;
    let otherUserId: string;
    let gameId: string;

    async function canonicalIdFor(linkId: string): Promise<string> {
        return (await pool.query("select canonical_achievement_id from achievement_platform_links where id = $1", [linkId])).rows[0]
            .canonical_achievement_id;
    }

    async function achievementPair(suffix: string): Promise<[string, string]> {
        const a = await canonicalStore.getOrCreateAchievementLink(gameId, "steam", "icon-merge", `a-${suffix}`, `Icon ${suffix}`, undefined, 40);
        const b = await canonicalStore.getOrCreateAchievementLink(gameId, "xbox", "icon-merge-x", `b-${suffix}`, `Icon ${suffix}`, undefined, 40);
        return [await canonicalIdFor(a), await canonicalIdFor(b)];
    }

    async function iconOverride(user: string, canonicalId: string): Promise<string | undefined> {
        return (
            await pool.query("select icon_url from user_achievement_icon_overrides where user_id = $1 and canonical_achievement_id = $2", [
                user,
                canonicalId,
            ])
        ).rows[0]?.icon_url;
    }

    async function setIcon(user: string, canonicalId: string, url: string): Promise<void> {
        await pool.query("insert into user_achievement_icon_overrides (user_id, canonical_achievement_id, icon_url) values ($1, $2, $3)", [
            user,
            canonicalId,
            url,
        ]);
    }

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for integration tests");
        ({ pool } = await import("../db"));
        canonicalStore = await import("../sync/canonicalStore");
        ({ mergeAchievements } = await import("./achievementMatcher"));
        await pool.query("truncate table users, games, canonical_achievements cascade");
        userId = (await pool.query("insert into users (username) values ('icon-merge-user') returning id")).rows[0].id;
        otherUserId = (await pool.query("insert into users (username) values ('icon-merge-other') returning id")).rows[0].id;
        gameId = await canonicalStore.getOrCreateCanonicalGame("steam", "icon-merge", "Icon Merge");
    });

    afterAll(async () => {
        await pool?.end();
    });

    it("moves the loser's icon override to the winner", async () => {
        const [winner, loser] = await achievementPair("one");
        await setIcon(userId, loser, "https://example.com/mine.png");

        await mergeAchievements(winner, loser);

        expect(await iconOverride(userId, winner)).toBe("https://example.com/mine.png");
    });

    it("keeps an icon the user already has on the winner, per user", async () => {
        const [winner, loser] = await achievementPair("two");
        await setIcon(userId, winner, "https://example.com/keep.png");
        await setIcon(userId, loser, "https://example.com/drop.png");
        await setIcon(otherUserId, loser, "https://example.com/other.png");

        await mergeAchievements(winner, loser);

        expect(await iconOverride(userId, winner)).toBe("https://example.com/keep.png");
        expect(await iconOverride(otherUserId, winner)).toBe("https://example.com/other.png");
    });
});
