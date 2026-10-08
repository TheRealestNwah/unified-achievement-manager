import fs from "fs";
import path from "path";

// Reads one game's trophy folder as RPCS3 writes it (see #521):
// dev_hdd0/home/<user>/trophy/<NP communication ID>/ holding TROPUSR.DAT
// (unlock state and times), TROPCONF.SFM (names, details, grades) and the
// TROP###.PNG / ICON0.PNG icons. Read-only: RPCS3 owns these files.

export type TrophyGrade = "platinum" | "gold" | "silver" | "bronze";

export interface Rpcs3Trophy {
    id: number;
    name: string;
    detail: string;
    grade: TrophyGrade;
    hidden: boolean;
    unlocked: boolean;
    // null for an unlock RPCS3 stored without a time (timestamp 0).
    unlockedAt: Date | null;
    // The icon's file name in the folder, when it exists.
    iconFile: string | null;
}

export interface Rpcs3TrophySet {
    communicationId: string;
    title: string;
    iconFile: string | null;
    trophies: Rpcs3Trophy[];
}

export class TrophyFileError extends Error {}

const TROPUSR_MAGIC = 0x818f54ad;
const HEADER_SIZE = 0x30;
const TABLE_HEADER_SIZE = 0x20;
// Each entry is a 16-byte header (type, size, id, unknown) followed by
// `entries_size` bytes of data, so the stride is entries_size + 0x10.
const ENTRY_HEADER_SIZE = 0x10;
const UNLOCK_TABLE = 6;
// PS3 RTC ticks: microseconds since 0001-01-01 00:00 UTC.
const TICKS_AT_UNIX_EPOCH = 62_135_596_800_000_000n;

const GRADES: Record<string, TrophyGrade> = { P: "platinum", G: "gold", S: "silver", B: "bronze" };

// NPWR01234_00 and the like - also what keeps a folder name from being
// turned into a path outside the trophy folder.
export const COMMUNICATION_ID = /^[A-Z]{4}\d{5}_\d{2}$/;

interface Unlock {
    unlocked: boolean;
    unlockedAt: Date | null;
}

export function ticksToDate(ticks: bigint): Date | null {
    if (ticks <= TICKS_AT_UNIX_EPOCH) return null;
    return new Date(Number((ticks - TICKS_AT_UNIX_EPOCH) / 1000n));
}

export function parseTropusr(buffer: Buffer): Map<number, Unlock> {
    if (buffer.length < HEADER_SIZE || buffer.readUInt32BE(0) !== TROPUSR_MAGIC) {
        throw new TrophyFileError("TROPUSR.DAT isn't an RPCS3 trophy file");
    }
    const tableCount = buffer.readUInt32BE(8);
    const unlocks = new Map<number, Unlock>();
    for (let t = 0; t < tableCount; t++) {
        const header = HEADER_SIZE + t * TABLE_HEADER_SIZE;
        if (header + TABLE_HEADER_SIZE > buffer.length) throw new TrophyFileError("TROPUSR.DAT is cut short");
        const type = buffer.readUInt32BE(header);
        if (type !== UNLOCK_TABLE) continue;
        const entrySize = buffer.readUInt32BE(header + 4);
        const count = buffer.readUInt32BE(header + 12);
        const offset = Number(buffer.readBigUInt64BE(header + 16));
        const stride = entrySize + ENTRY_HEADER_SIZE;
        if (entrySize < 0x20 || offset + count * stride > buffer.length) throw new TrophyFileError("TROPUSR.DAT is cut short");
        for (let e = 0; e < count; e++) {
            const entry = offset + e * stride;
            const id = buffer.readUInt32BE(entry + 0x10);
            const unlocked = buffer.readUInt32BE(entry + 0x14) === 1;
            unlocks.set(id, { unlocked, unlockedAt: unlocked ? ticksToDate(buffer.readBigUInt64BE(entry + 0x20)) : null });
        }
    }
    return unlocks;
}

function decodeXml(text: string): string {
    return text
        .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&")
        .trim();
}

function element(xml: string, tag: string): string | null {
    const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
    return match ? decodeXml(match[1]) : null;
}

function attribute(attrs: string, name: string): string | null {
    const match = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
    return match ? match[1] : null;
}

export interface TrophyConfig {
    title: string;
    trophies: { id: number; name: string; detail: string; grade: TrophyGrade; hidden: boolean }[];
}

// A small, fixed XML format (after a signature comment), so a few patterns
// rather than an XML parser dependency.
export function parseTropconf(xml: string): TrophyConfig {
    if (!/<trophyconf\b/.test(xml)) throw new TrophyFileError("TROPCONF.SFM isn't a trophy list");
    const trophies: TrophyConfig["trophies"] = [];
    for (const match of xml.matchAll(/<trophy\b([^>]*)>([\s\S]*?)<\/trophy>/g)) {
        const [, attrs, body] = match;
        const id = Number(attribute(attrs, "id"));
        const grade = GRADES[attribute(attrs, "ttype") ?? ""];
        if (!Number.isInteger(id) || !grade) continue;
        trophies.push({
            id,
            name: element(body, "name") ?? `Trophy ${id}`,
            detail: element(body, "detail") ?? "",
            grade,
            hidden: attribute(attrs, "hidden") === "yes",
        });
    }
    return { title: element(xml, "title-name") ?? "", trophies };
}

function existing(dir: string, file: string): string | null {
    return fs.existsSync(path.join(dir, file)) ? file : null;
}

export async function readTrophySet(folder: string): Promise<Rpcs3TrophySet> {
    const communicationId = path.basename(folder);
    const [usr, conf] = await Promise.all([
        fs.promises.readFile(path.join(folder, "TROPUSR.DAT")),
        fs.promises.readFile(path.join(folder, "TROPCONF.SFM"), "utf8"),
    ]);
    const unlocks = parseTropusr(usr);
    const config = parseTropconf(conf);
    return {
        communicationId,
        title: config.title || communicationId,
        iconFile: existing(folder, "ICON0.PNG"),
        trophies: config.trophies.map((t) => ({
            ...t,
            unlocked: unlocks.get(t.id)?.unlocked ?? false,
            unlockedAt: unlocks.get(t.id)?.unlockedAt ?? null,
            iconFile: existing(folder, `TROP${String(t.id).padStart(3, "0")}.PNG`),
        })),
    };
}
