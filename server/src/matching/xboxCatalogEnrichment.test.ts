import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
vi.mock("../db", () => ({ pool: { query: (...args: unknown[]) => query(...args) } }));
vi.mock("../config", () => ({ config: { credentialEncryptionKey: Buffer.alloc(32) } }));
vi.mock("../security/credentials", () => ({ decryptCredential: () => "key" }));
vi.mock("../sync/canonicalStore", () => ({ getOrCreateAchievementLink: vi.fn() }));

const searchMarketplace = vi.fn();
vi.mock("../xbox/client", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../xbox/client")>();
    return {
        ...actual,
        searchMarketplace: (...args: unknown[]) => searchMarketplace(...args),
        getTitleIdForProduct: vi.fn(),
        getAchievementsForTitle: vi.fn(),
    };
});

import { XboxApiError } from "../xbox/client";
import {
    enrichGamesWithXboxCatalog,
    resetXboxEnrichmentThrottle,
    XBOX_ENRICHMENT_GAMES_PER_RUN,
    XBOX_ENRICHMENT_INTERVAL_MS,
} from "./xboxCatalogEnrichment";

const candidates = [
    { id: "g1", title: "Game One" },
    { id: "g2", title: "Game Two" },
];

function mockDb() {
    query.mockImplementation(async (sql: string) => {
        if (sql.includes("platform_id = 'xbox' limit 1")) return { rows: [{ access_token: "enc" }] };
        if (sql.includes("select distinct g.id")) return { rows: candidates };
        return { rows: [], rowCount: 1 };
    });
}

describe("enrichGamesWithXboxCatalog rate limiting (#478)", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        resetXboxEnrichmentThrottle();
        query.mockReset();
        searchMarketplace.mockReset();
        searchMarketplace.mockResolvedValue([]);
        mockDb();
    });
    afterEach(() => vi.useRealTimers());

    it("asks for at most one batch of games per run", async () => {
        await enrichGamesWithXboxCatalog();
        const candidateQuery = query.mock.calls.find(([sql]) => String(sql).includes("select distinct g.id"));
        expect(String(candidateQuery?.[0])).toContain("limit $1");
        expect(candidateQuery?.[1]).toEqual([XBOX_ENRICHMENT_GAMES_PER_RUN]);
    });

    it("skips passes within an hour of the last one", async () => {
        await enrichGamesWithXboxCatalog();
        expect(searchMarketplace).toHaveBeenCalledTimes(2);

        vi.advanceTimersByTime(XBOX_ENRICHMENT_INTERVAL_MS - 1000);
        await enrichGamesWithXboxCatalog();
        expect(searchMarketplace).toHaveBeenCalledTimes(2);

        vi.advanceTimersByTime(1000);
        await enrichGamesWithXboxCatalog();
        expect(searchMarketplace).toHaveBeenCalledTimes(4);
    });

    it("backs off for an hour after a 429", async () => {
        searchMarketplace.mockRejectedValueOnce(new XboxApiError(429, "OpenXBL /v2/marketplace failed: 429"));
        await enrichGamesWithXboxCatalog();
        expect(searchMarketplace).toHaveBeenCalledTimes(1);

        await enrichGamesWithXboxCatalog();
        expect(searchMarketplace).toHaveBeenCalledTimes(1);
    });

    it("doesn't use up the hour when there's nothing to enrich", async () => {
        query.mockImplementation(async (sql: string) =>
            sql.includes("platform_id = 'xbox' limit 1") ? { rows: [{ access_token: "enc" }] } : { rows: [] }
        );
        await enrichGamesWithXboxCatalog();

        mockDb();
        await enrichGamesWithXboxCatalog();
        expect(searchMarketplace).toHaveBeenCalledTimes(2);
    });
});
