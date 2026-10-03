import { STEAMGRIDDB_API } from "../settings/steamGridDbKey";

export class SteamGridDbError extends Error {
    constructor(
        message: string,
        public status: number
    ) {
        super(message);
    }
}

export const GRID_STYLES = ["alternate", "blurred", "white_logo", "material", "no_logo"] as const;
// Portrait sizes only - the dashboard's cover box is 2:3.
const PORTRAIT_DIMENSIONS = "600x900,342x482,660x930";
const IMAGE_HOST = "cdn2.steamgriddb.com";

export interface GridFilters {
    animated: boolean;
    styles: string[];
}

export interface SteamGridDbGrid {
    id: number;
    url: string;
    thumb: string;
    width: number;
    height: number;
    style: string;
    author: string | null;
}

export interface SteamGridDbGame {
    id: number;
    name: string;
}

interface RawGrid {
    id: number;
    url: string;
    thumb: string;
    width: number;
    height: number;
    style: string;
    author?: { name?: string };
}

// Resolves to the response's `data`, or null when SteamGridDB has nothing for
// that game (404).
async function get<T>(path: string, apiKey: string, params: Record<string, string> = {}): Promise<T | null> {
    const url = new URL(`${STEAMGRIDDB_API}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (res.status === 404) return null;
    if (res.status === 401 || res.status === 403) {
        throw new SteamGridDbError("SteamGridDB rejected your API key. Update it in the SteamGridDB API key setting.", res.status);
    }
    if (!res.ok) throw new SteamGridDbError(`SteamGridDB didn't respond (${res.status}). Try again in a moment.`, res.status);
    const body = (await res.json()) as { data?: T };
    return body.data ?? null;
}

function gridParams(filters: GridFilters): Record<string, string> {
    const params: Record<string, string> = {
        dimensions: PORTRAIT_DIMENSIONS,
        types: filters.animated ? "animated" : "static",
        nsfw: "false",
        humor: "false",
        epilepsy: "false",
    };
    if (filters.styles.length) params.styles = filters.styles.join(",");
    return params;
}

function toGrid(raw: RawGrid): SteamGridDbGrid {
    return {
        id: raw.id,
        url: raw.url,
        thumb: raw.thumb,
        width: raw.width,
        height: raw.height,
        style: raw.style,
        author: raw.author?.name ?? null,
    };
}

export async function gridsForSteamApp(appId: string, apiKey: string, filters: GridFilters): Promise<SteamGridDbGrid[]> {
    const data = await get<RawGrid[]>(`/grids/steam/${encodeURIComponent(appId)}`, apiKey, gridParams(filters));
    return (data ?? []).map(toGrid);
}

export async function gridsForGame(gameId: number, apiKey: string, filters: GridFilters): Promise<SteamGridDbGrid[]> {
    const data = await get<RawGrid[]>(`/grids/game/${gameId}`, apiKey, gridParams(filters));
    return (data ?? []).map(toGrid);
}

export async function searchGames(term: string, apiKey: string): Promise<SteamGridDbGame[]> {
    const data = await get<SteamGridDbGame[]>(`/search/autocomplete/${encodeURIComponent(term)}`, apiKey);
    return (data ?? []).map(({ id, name }) => ({ id, name }));
}

export async function getGame(gameId: number, apiKey: string): Promise<SteamGridDbGame | null> {
    const data = await get<SteamGridDbGame>(`/games/id/${gameId}`, apiKey);
    return data ? { id: data.id, name: data.name } : null;
}

export async function getGameBySteamAppId(appId: string, apiKey: string): Promise<SteamGridDbGame | null> {
    const data = await get<SteamGridDbGame>(`/games/steam/${encodeURIComponent(appId)}`, apiKey);
    return data ? { id: data.id, name: data.name } : null;
}

// The select endpoint downloads a URL the client sent, so it only accepts
// SteamGridDB's own image CDN - anything else would let a request make the
// app fetch arbitrary (including local-network) addresses.
export function isSteamGridDbImageUrl(value: unknown): value is string {
    if (typeof value !== "string") return false;
    try {
        const url = new URL(value);
        return (
            url.protocol === "https:" &&
            url.hostname === IMAGE_HOST &&
            url.port === "" &&
            !url.username &&
            !url.password &&
            url.pathname.startsWith("/grid/")
        );
    } catch {
        return false;
    }
}

export async function downloadGridImage(url: string, maxBytes: number): Promise<{ buffer: Buffer; mimeType: string }> {
    const res = await fetch(url, { redirect: "error" });
    if (!res.ok || !res.body) throw new SteamGridDbError(`Couldn't download that image from SteamGridDB (${res.status}).`, res.status);
    if (Number(res.headers.get("content-length")) > maxBytes) {
        throw new SteamGridDbError("That image is too large to use as a cover.", 413);
    }

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxBytes) {
            await reader.cancel();
            throw new SteamGridDbError("That image is too large to use as a cover.", 413);
        }
        chunks.push(value);
    }

    const mimeType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    return { buffer: Buffer.concat(chunks), mimeType };
}
