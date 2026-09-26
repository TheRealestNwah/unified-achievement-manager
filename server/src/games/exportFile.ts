// Export downloads carry the local date, so a second export doesn't overwrite
// or get confused with the first (see #290). The server runs on the user's own
// machine, so its local date is the user's.
export function exportFileName(extension: "csv" | "json", now = new Date()): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    return `unified-achievement-manager-export-${date}.${extension}`;
}
