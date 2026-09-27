import { pool } from "../db";

const SETTING_KEY = "custom_search_acronyms";

export interface SearchAcronym {
    acronym: string;
    expansion: string;
}

// User-defined additions to the built-in acronym list in
// public/search-text.js (see #194) - e.g. "bg3" -> "baldur's gate". Stored
// as a single JSON blob in app_settings, like other small app-level config,
// since this is a short list a user edits occasionally, not a table that
// needs per-row queries.
export async function getSearchAcronyms(): Promise<SearchAcronym[]> {
    const result = await pool.query("select value from app_settings where key = $1", [SETTING_KEY]);
    if (!result.rows[0]) return [];
    try {
        const parsed = JSON.parse(result.rows[0].value);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

// Same folding the dashboard's search applies (public/search-text.js), so
// "BG3", "bg-3", and "bg3" count as one acronym (see #291).
export function normalizeAcronym(text: string): string {
    return text
        .replace(/[®™©℠]/g, "")
        .normalize("NFKD")
        .replace(/\p{M}/gu, "")
        .toLowerCase()
        .replace(/['’‘`´]/g, "")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
}

// The first acronym that appears twice, if any. Spacing is ignored too, so
// "bg 3" and "bg3" count as the same entry.
export function findDuplicateAcronym(acronyms: SearchAcronym[]): string | null {
    const seen = new Set<string>();
    for (const { acronym } of acronyms) {
        const key = normalizeAcronym(acronym).replace(/\s+/g, "");
        if (seen.has(key)) return acronym;
        seen.add(key);
    }
    return null;
}

export async function saveSearchAcronyms(acronyms: SearchAcronym[]): Promise<void> {
    await pool.query(
        `insert into app_settings (key, value) values ($1, $2)
         on conflict (key) do update set value = excluded.value, updated_at = now()`,
        [SETTING_KEY, JSON.stringify(acronyms)]
    );
}
