import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AchievementEntry, AchievementListResult, OwnedGame, PlatformAdapter } from "./platformAdapter";

const integrationEnabled = process.env.INTEGRATION_TESTS === "true";
const integration = integrationEnabled ? describe : describe.skip;

// The sync pipeline against a fake platform adapter: everything the pipeline
// promises, with no real platform involved.

function achievement(id: string, unlocked: boolean, extra: Partial<AchievementEntry> = {}): AchievementEntry {
    return { id, name: `Achievement ${id}`, unlocked, unlockedAt: unlocked ? new Date("2025-01-02T03:04:05.000Z") : null, ...extra };
}

function list(title: string, achievements: AchievementEntry[]): AchievementListResult {
    return { kind: "achievements", title, achievements };
}

// A platform whose owned games and achievement lists the test sets directly.
class FakePlatform {
    owned: OwnedGame[] = [];
    lists = new Map<string, AchievementListResult | Error>();
    fetched: string[] = [];
    refreshed?: { accessToken: string; refreshToken: string };
    seenAccount?: { accessToken: string | null; refreshToken: string | null };

    adapter: PlatformAdapter = {
        platformId: "gog",
        connect: async (account) => {
            this.seenAccount = { accessToken: account.accessToken, refreshToken: account.refreshToken };
            return {
                refreshedCredentials: this.refreshed,
                listOwnedGames: async () => this.owned,
                fetchAchievementList: async (game) => {
                    this.fetched.push(game.platformGameId);
                    const result = this.lists.get(game.platformGameId);
                    if (result instanceof Error) throw result;
                    return result ?? { kind: "none" };
                },
            };
        },
    };
}

integration("sync pipeline", () => {
    let pool: import("pg").Pool;
    let runSyncPipeline: typeof import("./pipeline").runSyncPipeline;
    let encryptCredential: typeof import("../security/credentials").encryptCredential;
    let decryptCredential: typeof import("../security/credentials").decryptCredential;
    let key: Buffer;
    let userId: string;
    let accountId: string;
    let platform: FakePlatform;

    const sync = () => runSyncPipeline(platform.adapter, accountId);

    async function ownedTitles(): Promise<string[]> {
        const result = await pool.query(
            `select g.title from user_owned_games uog join games g on g.id = uog.game_id
             where uog.user_platform_account_id = $1 order by g.title`,
            [accountId]
        );
        return result.rows.map((r) => r.title);
    }

    async function unlockedIds(): Promise<string[]> {
        const result = await pool.query(
            `select apl.platform_game_id || '/' || apl.platform_achievement_id as id
             from user_achievement_unlocks uau join achievement_platform_links apl on apl.id = uau.achievement_platform_link_id
             where uau.user_platform_account_id = $1 order by 1`,
            [accountId]
        );
        return result.rows.map((r) => r.id);
    }

    async function markers(): Promise<Record<string, string>> {
        const result = await pool.query("select platform_game_id, marker from change_markers where user_platform_account_id = $1", [accountId]);
        return Object.fromEntries(result.rows.map((r) => [r.platform_game_id, r.marker]));
    }

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for integration tests");
        ({ pool } = await import("../db"));
        ({ runSyncPipeline } = await import("./pipeline"));
        ({ encryptCredential, decryptCredential } = await import("../security/credentials"));
        key = (await import("../config")).config.credentialEncryptionKey;
        const { applySchema } = await import("../db/migrate");
        await applySchema();
    });

    beforeEach(async () => {
        await pool.query("truncate table users, games, canonical_achievements cascade");
        userId = (await pool.query("insert into users (username) values ('pipeline-user') returning id")).rows[0].id;
        accountId = (
            await pool.query(
                `insert into user_platform_accounts (user_id, platform_id, platform_account_id, display_name, access_token, refresh_token)
                 values ($1, 'gog', 'pipeline-account', 'Pipeline', $2, $3) returning id`,
                [userId, encryptCredential("old-access", key), encryptCredential("old-refresh", key)]
            )
        ).rows[0].id;
        platform = new FakePlatform();
    });

    afterAll(async () => {
        await pool?.end();
    });

    it("records games, unlocks and locked achievements, and counts every owned game", async () => {
        platform.owned = [{ platformGameId: "g1", details: undefined }, { platformGameId: "g2", details: undefined }, { platformGameId: "empty", details: undefined }, { platformGameId: "none", details: undefined, hasAchievements: false }];
        platform.lists.set("g1", list("Game One", [achievement("a", true), achievement("b", false)]));
        platform.lists.set("g2", list("Game Two", [achievement("c", true, { unlockedAt: null })]));
        platform.lists.set("empty", list("Empty Game", []));

        const summary = await sync();

        expect(summary).toEqual({ gamesProcessed: 4, achievementsUnlocked: 2, achievementsRevoked: 0, gamesReconciled: 0 });
        expect(platform.fetched).toEqual(["g1", "g2", "empty"]);
        // An empty achievement list creates no game.
        expect(await ownedTitles()).toEqual(["Game One", "Game Two"]);
        expect(await unlockedIds()).toEqual(["g1/a", "g2/c"]);
        const synced = await pool.query("select last_synced_at from user_platform_accounts where id = $1", [accountId]);
        expect(synced.rows[0].last_synced_at).toBeInstanceOf(Date);
    });

    it("hands the adapter decrypted credentials and saves refreshed ones encrypted", async () => {
        platform.refreshed = { accessToken: "new-access", refreshToken: "new-refresh" };
        await sync();

        expect(platform.seenAccount).toEqual({ accessToken: "old-access", refreshToken: "old-refresh" });
        const row = (await pool.query("select access_token, refresh_token from user_platform_accounts where id = $1", [accountId])).rows[0];
        expect(row.access_token).not.toBe("new-access");
        expect(decryptCredential(row.access_token, key)).toBe("new-access");
        expect(decryptCredential(row.refresh_token, key)).toBe("new-refresh");
    });

    it("revokes an unlock the platform now reports as locked", async () => {
        platform.owned = [{ platformGameId: "g1", details: undefined }];
        platform.lists.set("g1", list("Game One", [achievement("a", true)]));
        await sync();

        platform.lists.set("g1", list("Game One", [achievement("a", false)]));
        const summary = await sync();
        expect(summary).toMatchObject({ achievementsUnlocked: 0, achievementsRevoked: 1 });
        expect(await unlockedIds()).toEqual([]);
    });

    it("skips a game whose change marker is unchanged, and fetches it again once it changes", async () => {
        platform.owned = [{ platformGameId: "g1", details: undefined, changeMarker: "v1" }, { platformGameId: "empty", details: undefined, changeMarker: "e1" }];
        platform.lists.set("g1", list("Game One", [achievement("a", true)]));
        await sync();
        // Saved for an empty list too, so it isn't fetched every time.
        expect(await markers()).toEqual({ g1: "v1", empty: "e1" });

        platform.fetched = [];
        expect(await sync()).toMatchObject({ gamesProcessed: 2, achievementsUnlocked: 0 });
        expect(platform.fetched).toEqual([]);

        platform.owned = [{ platformGameId: "g1", details: undefined, changeMarker: "v2" }, { platformGameId: "empty", details: undefined, changeMarker: "e1" }];
        platform.lists.set("g1", list("Game One", [achievement("a", true), achievement("b", true)]));
        expect(await sync()).toMatchObject({ achievementsUnlocked: 1 });
        expect(platform.fetched).toEqual(["g1"]);
        expect(await markers()).toEqual({ g1: "v2", empty: "e1" });
    });

    it("aborts on a thrown error, keeping markers only for games fully recorded first", async () => {
        platform.owned = [{ platformGameId: "g1", details: undefined, changeMarker: "v1" }, { platformGameId: "g2", details: undefined, changeMarker: "v1" }];
        platform.lists.set("g1", list("Game One", [achievement("a", true)]));
        platform.lists.set("g2", new Error("Rate limited"));

        await expect(sync()).rejects.toThrow("Rate limited");
        expect(await markers()).toEqual({ g1: "v1" });
        const synced = await pool.query("select last_synced_at from user_platform_accounts where id = $1", [accountId]);
        expect(synced.rows[0].last_synced_at).toBeNull();

        // The next sync picks up where it stopped.
        platform.lists.set("g2", list("Game Two", [achievement("b", true)]));
        platform.fetched = [];
        await sync();
        expect(platform.fetched).toEqual(["g2"]);
    });

    it("logs a game the adapter skips, carries on, and still treats it as owned", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        platform.owned = [{ platformGameId: "g1", details: undefined }, { platformGameId: "g2", details: undefined }];
        platform.lists.set("g1", list("Game One", [achievement("a", true)]));
        platform.lists.set("g2", list("Game Two", [achievement("b", true)]));
        await sync();

        platform.lists.set("g1", { kind: "skip", reason: "file busy" });
        for (let i = 0; i < 3; i++) {
            expect(await sync()).toMatchObject({ gamesProcessed: 2, gamesReconciled: 0 });
        }
        expect(warn).toHaveBeenCalledWith("gog: skipped g1: file busy");
        expect(await ownedTitles()).toEqual(["Game One", "Game Two"]);
        expect(await unlockedIds()).toEqual(["g1/a", "g2/b"]);
        warn.mockRestore();
    });

    it("reconciles a game missing from the owned list after repeated absences", async () => {
        platform.owned = [{ platformGameId: "g1", details: undefined }, { platformGameId: "g2", details: undefined }];
        platform.lists.set("g1", list("Game One", [achievement("a", true)]));
        platform.lists.set("g2", list("Game Two", [achievement("b", true)]));
        await sync();

        platform.owned = [{ platformGameId: "g1", details: undefined }];
        const results = [await sync(), await sync(), await sync()];
        expect(results.map((r) => r.gamesReconciled)).toEqual([0, 0, 1]);
        expect(results[2].achievementsRevoked).toBe(1);
        expect(await ownedTitles()).toEqual(["Game One"]);
    });
});
