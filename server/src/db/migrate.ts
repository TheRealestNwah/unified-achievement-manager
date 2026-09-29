import fs from "fs";
import path from "path";
import { pool } from "../db";
import { generateLevelThresholds } from "../scoring/levelCurve";
import { repairUnknownUnlockDates } from "./repairUnlockDates";

export async function seedLevelThresholds() {
    const thresholds = generateLevelThresholds();
    const values = thresholds.map((t) => `(${t.level}, ${t.pointsRequired})`).join(",");
    await pool.query(`
        insert into level_thresholds (level, points_required)
        values ${values}
        on conflict (level) do update set points_required = excluded.points_required
    `);
    console.log(`Seeded ${thresholds.length} level thresholds.`);
}

// Safe to run on every start: schema.sql is idempotent.
export async function applySchema() {
    const schemaPath = path.join(__dirname, "..", "..", "..", "db", "schema.sql");
    const sql = fs.readFileSync(schemaPath, "utf-8");
    await pool.query(sql);
    console.log("Schema applied.");
    await seedLevelThresholds();
    await repairUnknownUnlockDates();
}

if (require.main === module) {
    applySchema()
        .then(() => pool.end())
        .catch((err) => {
            console.error(err);
            process.exit(1);
        });
}
