import fs from "fs";
import path from "path";
import readline from "readline";
import { Client } from "pg";
import { startEmbeddedDatabase } from "./embeddedDatabase";

// Platform-neutral export/import of the app's data (see #528). Backups copy
// PostgreSQL's own files, which only work on the same OS and CPU; an export
// holds every table as JSON lines instead, so it loads on any machine.
// Both need the app's server stopped: they start the data folder's database
// themselves.

export const PORTABLE_FORMAT = "unified-achievement-manager-export";
export const PORTABLE_VERSION = 1;
const MANIFEST = "manifest.json";
const TABLES_DIR = "tables";
// Express sessions: tied to this install's cookie secret and worthless elsewhere.
const SKIPPED_TABLES = new Set(["session"]);
const BATCH_ROWS = 500;

interface ManifestTable {
    name: string;
    columns: string[];
    rows: number;
}

export interface PortableManifest {
    format: typeof PORTABLE_FORMAT;
    version: number;
    appVersion: string;
    exportedAt: string;
    tables: ManifestTable[];
}

// Same file applySchema() runs: <repo or resources>/db/schema.sql, three
// levels up from dist/runtime (or src/runtime under ts-node/vitest).
function schemaPath(): string {
    return path.join(__dirname, "..", "..", "..", "db", "schema.sql");
}

function quoteIdent(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
}

async function listTables(client: Client): Promise<Map<string, string[]>> {
    // Stored generated columns can't be written, so they're left out.
    const { rows } = await client.query<{ table_name: string; column_name: string }>(`
        select c.relname as table_name, a.attname as column_name
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_attribute a on a.attrelid = c.oid
        where n.nspname = 'public' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
        order by c.relname, a.attnum
    `);
    const tables = new Map<string, string[]>();
    for (const row of rows) {
        if (SKIPPED_TABLES.has(row.table_name)) continue;
        const columns = tables.get(row.table_name) ?? [];
        columns.push(row.column_name);
        tables.set(row.table_name, columns);
    }
    return tables;
}

async function withDatabase<T>(dataDir: string, task: (client: Client) => Promise<T>): Promise<T> {
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

function copyIfPresent(from: string, to: string): void {
    if (fs.existsSync(from)) fs.cpSync(from, to, { recursive: true });
}

// Writes the export into outDir (which the caller archives). Rows are read
// in one repeatable-read transaction, so every table is from the same moment.
export async function exportPortableData(dataDir: string, outDir: string, appVersion: string): Promise<PortableManifest> {
    const tablesDir = path.join(outDir, TABLES_DIR);
    fs.mkdirSync(tablesDir, { recursive: true });
    const tables: ManifestTable[] = [];

    await withDatabase(dataDir, async (client) => {
        await client.query("begin isolation level repeatable read read only");
        try {
            for (const [name, columns] of await listTables(client)) {
                const file = path.join(tablesDir, `${name}.jsonl`);
                fs.writeFileSync(file, "");
                const selectList = columns.map(quoteIdent).join(", ");
                // row_to_json keeps numerics and bigints as written, and the
                // text is never parsed here, so nothing loses precision.
                await client.query(`declare export_rows no scroll cursor for select row_to_json(t)::text as line from (select ${selectList} from ${quoteIdent(name)}) t`);
                let rows = 0;
                for (;;) {
                    const batch = await client.query<{ line: string }>(`fetch ${BATCH_ROWS} from export_rows`);
                    if (batch.rows.length === 0) break;
                    fs.appendFileSync(file, batch.rows.map((row) => `${row.line}\n`).join(""));
                    rows += batch.rows.length;
                }
                await client.query("close export_rows");
                tables.push({ name, columns, rows });
            }
        } finally {
            await client.query("rollback");
        }
    });

    // The credential key travels with the data: without it the stored platform
    // logins can't be decrypted.
    fs.copyFileSync(path.join(dataDir, "secrets.json"), path.join(outDir, "secrets.json"));
    copyIfPresent(path.join(dataDir, "uploads"), path.join(outDir, "uploads"));

    const manifest: PortableManifest = { format: PORTABLE_FORMAT, version: PORTABLE_VERSION, appVersion, exportedAt: new Date().toISOString(), tables };
    fs.writeFileSync(path.join(outDir, MANIFEST), JSON.stringify(manifest, null, 2));
    return manifest;
}

export class PortableImportError extends Error {}

function readManifest(fromDir: string): PortableManifest {
    const file = path.join(fromDir, MANIFEST);
    let manifest: Partial<PortableManifest>;
    try {
        manifest = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<PortableManifest>;
    } catch {
        throw new PortableImportError("That file isn't a Unified Achievement Manager export (it has no manifest).");
    }
    if (manifest.format !== PORTABLE_FORMAT || !Array.isArray(manifest.tables)) {
        throw new PortableImportError("That file isn't a Unified Achievement Manager export.");
    }
    if (typeof manifest.version !== "number" || manifest.version > PORTABLE_VERSION) {
        throw new PortableImportError(`That export was made by a newer version of the app (${manifest.appVersion ?? "unknown"}). Update this copy first.`);
    }
    if (!fs.existsSync(path.join(fromDir, "secrets.json"))) {
        throw new PortableImportError("That export is incomplete (secrets.json is missing).");
    }
    for (const table of manifest.tables) {
        if (!fs.existsSync(path.join(fromDir, TABLES_DIR, `${table.name}.jsonl`))) {
            throw new PortableImportError(`That export is incomplete (the ${table.name} table is missing).`);
        }
    }
    return manifest as PortableManifest;
}

// An export from an older version loads (columns it doesn't have get their
// defaults); one with tables or columns this version doesn't know would lose
// data, so it's refused.
function checkCompatible(manifest: PortableManifest, known: Map<string, string[]>): void {
    for (const table of manifest.tables) {
        const columns = known.get(table.name);
        const unknown = columns ? table.columns.filter((column) => !columns.includes(column)) : [table.name];
        if (unknown.length > 0) {
            throw new PortableImportError(
                `That export was made by a newer version of the app (${manifest.appVersion}) and has data this version can't hold. Update this copy first.`
            );
        }
    }
}

async function loadTable(client: Client, fromDir: string, table: ManifestTable): Promise<number> {
    const columnList = table.columns.map(quoteIdent).join(", ");
    const insert = `insert into ${quoteIdent(table.name)} (${columnList}) overriding system value
        select ${columnList} from json_populate_recordset(null::${quoteIdent(table.name)}, $1::json)`;
    const lines = readline.createInterface({ input: fs.createReadStream(path.join(fromDir, TABLES_DIR, `${table.name}.jsonl`), "utf8"), crlfDelay: Infinity });
    let batch: string[] = [];
    let loaded = 0;
    const flush = async () => {
        if (batch.length === 0) return;
        await client.query(insert, [`[${batch.join(",")}]`]);
        loaded += batch.length;
        batch = [];
    };
    for await (const line of lines) {
        if (!line.trim()) continue;
        batch.push(line);
        if (batch.length >= BATCH_ROWS) await flush();
    }
    await flush();
    return loaded;
}

// Serial and identity columns would otherwise hand out ids the imported rows
// already use.
async function resetSequences(client: Client): Promise<void> {
    const { rows } = await client.query<{ table_name: string; column_name: string; sequence: string }>(`
        select c.relname as table_name, a.attname as column_name, pg_get_serial_sequence(quote_ident(c.relname), a.attname) as sequence
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_attribute a on a.attrelid = c.oid
        where n.nspname = 'public' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
          and pg_get_serial_sequence(quote_ident(c.relname), a.attname) is not null
    `);
    for (const row of rows) {
        await client.query(
            `select setval($1, coalesce((select max(${quoteIdent(row.column_name)}) from ${quoteIdent(row.table_name)}), 0) + 1, false)`,
            [row.sequence]
        );
    }
}

function timestamp(): string {
    return new Date().toISOString().replace(/[:.]/g, "-");
}

// The parts of the data folder an import replaces. database.json (the local
// database password) stays: the fresh database is created with it.
const REPLACED = ["postgres", "secrets.json", "uploads"];

// Replaces the data folder's database, secrets and uploads with an export
// that the caller has already extracted into fromDir. The current ones are
// moved into "<data folder>/before import <time>" rather than deleted, and
// put back if anything fails. Returns that folder.
export async function importPortableData(dataDir: string, fromDir: string): Promise<string> {
    const manifest = readManifest(fromDir);

    const previous = path.join(dataDir, `before import ${timestamp()}`);
    fs.mkdirSync(previous, { recursive: true });
    const moved: string[] = [];
    let placing = false;
    try {
        for (const item of REPLACED) {
            if (!fs.existsSync(path.join(dataDir, item))) continue;
            fs.renameSync(path.join(dataDir, item), path.join(previous, item));
            moved.push(item);
        }
        placing = true;
        fs.copyFileSync(path.join(fromDir, "secrets.json"), path.join(dataDir, "secrets.json"));
        copyIfPresent(path.join(fromDir, "uploads"), path.join(dataDir, "uploads"));

        await withDatabase(dataDir, async (client) => {
            await client.query(fs.readFileSync(schemaPath(), "utf8"));
            checkCompatible(manifest, await listTables(client));
            await client.query("begin");
            // Rows go in table by table, so foreign keys are checked by
            // nothing until every table is loaded; the app's database user
            // owns the cluster, so it may switch them off for this session.
            await client.query("set local session_replication_role = replica");
            // The schema seeds some tables (platforms, tiers, levels); the
            // export's own copies replace them.
            const names = manifest.tables.map((table) => quoteIdent(table.name));
            if (names.length > 0) await client.query(`truncate ${names.join(", ")}`);
            for (const table of manifest.tables) {
                const loaded = await loadTable(client, fromDir, table);
                if (loaded !== table.rows) throw new Error(`The ${table.name} table should have ${table.rows} rows but has ${loaded}`);
            }
            await resetSequences(client);
            await client.query("commit");
        });
    } catch (err) {
        // Put everything back the way it was.
        if (placing) for (const item of REPLACED) fs.rmSync(path.join(dataDir, item), { recursive: true, force: true });
        for (const item of moved) fs.renameSync(path.join(previous, item), path.join(dataDir, item));
        fs.rmSync(previous, { recursive: true, force: true });
        throw err;
    }
    return previous;
}
