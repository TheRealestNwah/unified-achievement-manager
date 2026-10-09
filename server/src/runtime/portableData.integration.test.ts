import fs from "fs";
import os from "os";
import path from "path";
import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { startEmbeddedDatabase } from "./embeddedDatabase";
import { exportPortableData, importPortableData, PortableImportError } from "./portableData";

const enabled = process.env.EMBEDDED_PG_TESTS === "true";
const suite = enabled ? describe : describe.skip;

const SCHEMA = fs.readFileSync(path.join(__dirname, "..", "..", "..", "db", "schema.sql"), "utf8");

async function withClient<T>(dataDir: string, task: (client: Client) => Promise<T>): Promise<T> {
    const database = await startEmbeddedDatabase(dataDir);
    try {
        const client = new Client({ connectionString: database.url });
        await client.connect();
        try {
            return await task(client);
        } finally {
            await client.end();
        }
    } finally {
        await database.stop();
    }
}

function writeSecrets(dataDir: string, key: string): void {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "secrets.json"), JSON.stringify({ sessionSecret: `session-${key}`, credentialEncryptionKey: key }));
}

const LIBRARY = `
    select g.title, c.name, c.tier::text, l.global_unlock_rarity::text as rarity, u.unlocked_at, a.access_token
    from user_achievement_unlocks u
    join achievement_platform_links l on l.id = u.achievement_platform_link_id
    join canonical_achievements c on c.id = l.canonical_achievement_id
    join games g on g.id = c.game_id
    join user_platform_accounts a on a.id = u.user_platform_account_id
    order by c.name
`;

suite("portable export/import (#528)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "uam-portable-"));
    const source = path.join(root, "source");
    const target = path.join(root, "target");
    const exported = path.join(root, "export");

    afterAll(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    it("moves a library, its secrets and uploads into another data folder", async () => {
        writeSecrets(source, "source-key");
        fs.mkdirSync(path.join(source, "uploads", "covers"), { recursive: true });
        fs.writeFileSync(path.join(source, "uploads", "covers", "cover.png"), "png bytes");
        const before = await withClient(source, async (client) => {
            await client.query(SCHEMA);
            await client.query(`
                with u as (insert into users (username) values ('Player') returning id),
                     a as (insert into user_platform_accounts (user_id, platform_id, platform_account_id, access_token, local_folder)
                           select id, 'steam', '7656', 'enc:v1:token', 'C:\\Games\\RPCS3' from u returning id),
                     g as (insert into games (title, cover_image_url) values ('Café "Quotes"
New line', '/uploads/covers/cover.png') returning id),
                     c as (insert into canonical_achievements (game_id, name, tier, tier_source, points)
                           select id, 'First', 'gold', 'rarity_fallback', 90 from g returning id),
                     l as (insert into achievement_platform_links (canonical_achievement_id, platform_id, platform_game_id, platform_achievement_id, platform_name, global_unlock_rarity)
                           select id, 'steam', '10', 'ACH_1', 'First', 12.34 from c returning id)
                insert into user_achievement_unlocks (user_platform_account_id, achievement_platform_link_id, unlocked_at)
                select a.id, l.id, '2020-01-02T03:04:05.678Z' from a, l
            `);
            await client.query("insert into session (sid, sess, expire) values ('s', '{}', now())");
            return (await client.query(LIBRARY)).rows;
        });
        expect(before).toHaveLength(1);

        const manifest = await exportPortableData(source, exported, "1.2.3");
        expect(manifest.appVersion).toBe("1.2.3");
        expect(manifest.tables.find((t) => t.name === "session")).toBeUndefined();
        expect(manifest.tables.find((t) => t.name === "games")?.rows).toBe(1);

        // The target already has its own (different) data, which gets moved aside.
        writeSecrets(target, "target-key");
        await withClient(target, async (client) => {
            await client.query(SCHEMA);
            await client.query("insert into users (username) values ('Someone else')");
        });

        const previous = await importPortableData(target, exported);

        expect(JSON.parse(fs.readFileSync(path.join(target, "secrets.json"), "utf8")).credentialEncryptionKey).toBe("source-key");
        expect(JSON.parse(fs.readFileSync(path.join(previous, "secrets.json"), "utf8")).credentialEncryptionKey).toBe("target-key");
        expect(fs.readFileSync(path.join(target, "uploads", "covers", "cover.png"), "utf8")).toBe("png bytes");
        expect(fs.existsSync(path.join(previous, "postgres", "PG_VERSION"))).toBe(true);

        await withClient(target, async (client) => {
            expect((await client.query(LIBRARY)).rows).toEqual(before);
            expect((await client.query("select username from users")).rows).toEqual([{ username: "Player" }]);
            expect((await client.query("select local_folder from user_platform_accounts")).rows).toEqual([{ local_folder: "C:\\Games\\RPCS3" }]);
            expect(Number((await client.query("select count(*) from platforms")).rows[0].count)).toBeGreaterThan(0);
            // Foreign keys hold after the load.
            const orphans = await client.query(
                "select count(*) from user_achievement_unlocks u left join user_platform_accounts a on a.id = u.user_platform_account_id where a.id is null"
            );
            expect(Number(orphans.rows[0].count)).toBe(0);
        });
    }, 300_000);

    it("refuses an export with columns this version doesn't know, leaving the data alone", async () => {
        const manifestFile = path.join(exported, "manifest.json");
        const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
        manifest.tables.find((t: { name: string }) => t.name === "games").columns.push("from_the_future");
        fs.writeFileSync(manifestFile, JSON.stringify(manifest));

        const entries = fs.readdirSync(target).sort();
        await expect(importPortableData(target, exported)).rejects.toThrow(/newer version/);
        expect(fs.readdirSync(target).sort()).toEqual(entries);
        await withClient(target, async (client) => {
            expect((await client.query("select username from users")).rows).toEqual([{ username: "Player" }]);
        });
    }, 300_000);

    it("refuses a folder that isn't an export before touching anything", async () => {
        const notExport = path.join(root, "not-an-export");
        fs.mkdirSync(notExport);
        const entries = fs.readdirSync(target).sort();
        await expect(importPortableData(target, notExport)).rejects.toBeInstanceOf(PortableImportError);
        expect(fs.readdirSync(target).sort()).toEqual(entries);
    });
});
