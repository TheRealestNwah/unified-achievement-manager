import { Pool } from "pg";
import { config } from "./config";

export const pool = new Pool({ connectionString: config.databaseUrl });

// An idle client whose connection drops (the database was stopped or crashed)
// emits "error" through the pool; unhandled, that takes the whole app down
// (see #419). The pool has already discarded the client, so just log it.
pool.on("error", (err) => {
    console.error("A database connection dropped:", err.message);
});

export async function checkDatabaseConnection(): Promise<void> {
    await pool.query("select 1");
}
