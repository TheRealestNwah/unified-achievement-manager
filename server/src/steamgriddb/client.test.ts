import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db", () => ({ pool: { query: vi.fn() } }));

import { SteamGridDbError, downloadGridImage, getGame, getGameBySteamAppId, gridsForSteamApp, isSteamGridDbImageUrl, searchGames } from "./client";

const fetchMock = vi.fn();

function requested(call = 0): { url: URL; init: RequestInit } {
    const [url, init] = fetchMock.mock.calls[call];
    return { url: new URL(String(url)), init };
}

beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("SteamGridDB grid lookups", () => {
    it("asks for portrait, static, safe grids for a Steam app and trims the response", async () => {
        fetchMock.mockResolvedValueOnce(
            Response.json({
                success: true,
                data: [
                    {
                        id: 7,
                        url: "https://cdn2.steamgriddb.com/grid/a.png",
                        thumb: "https://cdn2.steamgriddb.com/thumb/a.jpg",
                        width: 600,
                        height: 900,
                        style: "alternate",
                        score: 3,
                        author: { name: "artist", steam64: "1", avatar: "x" },
                    },
                ],
            })
        );

        const grids = await gridsForSteamApp("220", "key", { animated: false, styles: ["material"] });

        const { url, init } = requested();
        expect(url.pathname).toBe("/api/v2/grids/steam/220");
        expect(url.searchParams.get("dimensions")).toBe("600x900,342x482,660x930");
        expect(url.searchParams.get("types")).toBe("static");
        expect(url.searchParams.get("styles")).toBe("material");
        expect(url.searchParams.get("nsfw")).toBe("false");
        expect(url.searchParams.get("humor")).toBe("false");
        expect(url.searchParams.get("epilepsy")).toBe("false");
        expect((init.headers as Record<string, string>).Authorization).toBe("Bearer key");
        expect(grids).toEqual([
            {
                id: 7,
                url: "https://cdn2.steamgriddb.com/grid/a.png",
                thumb: "https://cdn2.steamgriddb.com/thumb/a.jpg",
                width: 600,
                height: 900,
                style: "alternate",
                author: "artist",
            },
        ]);
    });

    it("treats a game SteamGridDB doesn't know as having no grids", async () => {
        fetchMock.mockResolvedValueOnce(Response.json({ success: false }, { status: 404 }));
        await expect(gridsForSteamApp("999999999", "key", { animated: true, styles: [] })).resolves.toEqual([]);
        expect(requested().url.searchParams.get("types")).toBe("animated");
        expect(requested().url.searchParams.has("styles")).toBe(false);
    });

    it("reports a rejected key as a SteamGridDB error", async () => {
        fetchMock.mockResolvedValueOnce(Response.json({ success: false }, { status: 401 }));
        await expect(gridsForSteamApp("220", "bad", { animated: false, styles: [] })).rejects.toMatchObject({ status: 401 });
    });

    it("URL-encodes the search term and keeps only id and name", async () => {
        fetchMock.mockResolvedValueOnce(Response.json({ success: true, data: [{ id: 5, name: "Halo: Reach", types: ["steam"], verified: true }] }));

        await expect(searchGames("Halo: Reach / MCC", "key")).resolves.toEqual([{ id: 5, name: "Halo: Reach" }]);
        expect(String(fetchMock.mock.calls[0][0])).toContain("/search/autocomplete/Halo%3A%20Reach%20%2F%20MCC");
    });
});

describe("SteamGridDB game lookup by ID", () => {
    it("returns the game's id and name", async () => {
        fetchMock.mockResolvedValueOnce(Response.json({ success: true, data: { id: 42, name: "Resident Evil 5", verified: true } }));
        await expect(getGame(42, "key")).resolves.toEqual({ id: 42, name: "Resident Evil 5" });
        expect(requested().url.pathname).toMatch(/\/games\/id\/42$/);
    });

    it("returns null for an unknown game", async () => {
        fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
        await expect(getGame(999, "key")).resolves.toBeNull();
    });

    it("looks a game up by Steam app ID", async () => {
        fetchMock.mockResolvedValueOnce(Response.json({ success: true, data: { id: 42, name: "Resident Evil 5", verified: true } }));
        await expect(getGameBySteamAppId("21690", "key")).resolves.toEqual({ id: 42, name: "Resident Evil 5" });
        expect(requested().url.pathname).toMatch(/\/games\/steam\/21690$/);
    });
});

describe("SteamGridDB image URLs", () => {
    it.each([
        ["https://cdn2.steamgriddb.com/grid/abc.png", true],
        ["http://cdn2.steamgriddb.com/grid/abc.png", false],
        ["https://cdn2.steamgriddb.com/thumb/abc.jpg", false],
        ["https://cdn2.steamgriddb.com.evil.test/grid/abc.png", false],
        ["https://user:pw@cdn2.steamgriddb.com/grid/abc.png", false],
        ["https://cdn2.steamgriddb.com:8443/grid/abc.png", false],
        ["https://127.0.0.1/grid/abc.png", false],
        ["not a url", false],
        [42, false],
    ])("%s -> %s", (value, allowed) => {
        expect(isSteamGridDbImageUrl(value)).toBe(allowed);
    });
});

describe("downloading a picked grid", () => {
    it("refuses redirects and returns the bytes and content type", async () => {
        fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png; charset=binary" } }));

        const result = await downloadGridImage("https://cdn2.steamgriddb.com/grid/a.png", 10);

        expect(requested().init.redirect).toBe("error");
        expect(result.mimeType).toBe("image/png");
        expect([...result.buffer]).toEqual([1, 2, 3]);
    });

    it("stops reading once the image passes the size limit", async () => {
        fetchMock.mockResolvedValueOnce(new Response(new Uint8Array(11), { headers: { "content-type": "image/png" } }));
        await expect(downloadGridImage("https://cdn2.steamgriddb.com/grid/a.png", 10)).rejects.toBeInstanceOf(SteamGridDbError);
    });

    it("rejects an oversized image from its declared length without reading it", async () => {
        fetchMock.mockResolvedValueOnce(new Response(new Uint8Array(1), { headers: { "content-type": "image/png", "content-length": "999" } }));
        await expect(downloadGridImage("https://cdn2.steamgriddb.com/grid/a.png", 10)).rejects.toMatchObject({ status: 413 });
    });
});
