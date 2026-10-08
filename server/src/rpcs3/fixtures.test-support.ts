import fs from "fs";
import path from "path";

// Synthetic RPCS3 trophy files for tests, so no real game's files are copied
// into the repo.

const TICKS_AT_UNIX_EPOCH = 62_135_596_800_000_000n;

export function ticks(date: Date): bigint {
    return TICKS_AT_UNIX_EPOCH + BigInt(date.getTime()) * 1000n;
}

// Builds a TROPUSR.DAT the way RPCS3 lays it out: a 0x30-byte header, 0x20-
// byte table headers, then a grade table (type 4) and an unlock table (type
// 6) whose entries are a 16-byte header plus entries_size bytes.
export function buildTropusr(trophies: { id: number; unlocked: boolean; at?: bigint }[]): Buffer {
    const tables = [
        { type: 4, entrySize: 0x50 },
        { type: 6, entrySize: 0x60 },
    ];
    const headerEnd = 0x30 + tables.length * 0x20;
    let offset = headerEnd;
    const layout = tables.map((t) => {
        const start = offset;
        offset += trophies.length * (t.entrySize + 0x10);
        return { ...t, start };
    });
    const buffer = Buffer.alloc(offset);
    buffer.writeUInt32BE(0x818f54ad, 0);
    buffer.writeUInt32BE(0x00010000, 4);
    buffer.writeUInt32BE(tables.length, 8);
    layout.forEach((t, i) => {
        const h = 0x30 + i * 0x20;
        buffer.writeUInt32BE(t.type, h);
        buffer.writeUInt32BE(t.entrySize, h + 4);
        buffer.writeUInt32BE(1, h + 8);
        buffer.writeUInt32BE(trophies.length, h + 12);
        buffer.writeBigUInt64BE(BigInt(t.start), h + 16);
        trophies.forEach((trophy, e) => {
            const o = t.start + e * (t.entrySize + 0x10);
            buffer.writeUInt32BE(t.type, o);
            buffer.writeUInt32BE(t.entrySize, o + 4);
            buffer.writeUInt32BE(e, o + 8);
            buffer.writeUInt32BE(trophy.id, o + 0x10);
            if (t.type === 6) {
                buffer.writeUInt32BE(trophy.unlocked ? 1 : 0, o + 0x14);
                buffer.writeBigUInt64BE(trophy.at ?? 0n, o + 0x20);
                buffer.writeBigUInt64BE(trophy.at ?? 0n, o + 0x28);
            }
        });
    });
    return buffer;
}

export const TROPCONF = `<!--Sce-Np-Trophy-Signature: 0123abcd-->
<?xml version="1.0" encoding="UTF-8"?>
<trophyconf version="1.0">
 <npcommid>NPWR99999_00</npcommid>
 <title-name>Test &amp; Game</title-name>
 <trophy id="000" hidden="no" ttype="P" pid="-1"><name>All Done</name><detail>Get every trophy</detail></trophy>
 <trophy id="001" hidden="yes" ttype="B" pid="000"><name>First &quot;Steps&quot;</name><detail>Finish the tutorial</detail></trophy>
 <trophy id="002" hidden="no" ttype="G" pid="000"><name>Hard</name><detail>Beat it on hard</detail></trophy>
</trophyconf>`;

// One game folder: TROPCONF.SFM, TROPUSR.DAT and the named icons.
export function writeGameFolder(trophyDir: string, communicationId: string, trophies: { id: number; unlocked: boolean; at?: bigint }[], icons: string[] = []): string {
    const folder = path.join(trophyDir, communicationId);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "TROPUSR.DAT"), buildTropusr(trophies));
    fs.writeFileSync(path.join(folder, "TROPCONF.SFM"), TROPCONF.replace("NPWR99999_00", communicationId));
    for (const icon of icons) fs.writeFileSync(path.join(folder, icon), "");
    return folder;
}
