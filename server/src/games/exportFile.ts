// Export downloads carry the local date, so a second export doesn't overwrite
// or get confused with the first (see #290). The server runs on the user's own
// machine, so its local date is the user's.
export function exportFileName(extension: "csv" | "json", now = new Date()): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    return `unified-achievement-manager-export-${date}.${extension}`;
}

// Dates go out as ISO 8601, the same as the JSON export, rather than
// String(date)'s locale- and timezone-dependent form (see #335).
export function toCsv(rows: Record<string, unknown>[]): string {
    if (rows.length === 0) return "";
    const headers = Object.keys(rows[0]);
    const escape = (value: unknown) => {
        const str =
            value === null || value === undefined ? "" : value instanceof Date ? value.toISOString() : String(value);
        return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    };
    return [headers.join(","), ...rows.map((row) => headers.map((h) => escape(row[h])).join(","))].join("\n");
}
