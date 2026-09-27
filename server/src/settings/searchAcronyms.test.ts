import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
vi.mock("../db", () => ({ pool: { query: (...args: unknown[]) => queryMock(...args) } }));

beforeEach(() => {
    queryMock.mockReset();
});

describe("getSearchAcronyms", () => {
    it("returns an empty list when nothing has been saved", async () => {
        const { getSearchAcronyms } = await import("./searchAcronyms");
        queryMock.mockResolvedValueOnce({ rows: [] });
        await expect(getSearchAcronyms()).resolves.toEqual([]);
    });

    it("parses the saved JSON list", async () => {
        const { getSearchAcronyms } = await import("./searchAcronyms");
        queryMock.mockResolvedValueOnce({ rows: [{ value: '[{"acronym":"bg3","expansion":"baldur\'s gate"}]' }] });
        await expect(getSearchAcronyms()).resolves.toEqual([{ acronym: "bg3", expansion: "baldur's gate" }]);
    });

    it("falls back to an empty list on corrupt stored JSON", async () => {
        const { getSearchAcronyms } = await import("./searchAcronyms");
        queryMock.mockResolvedValueOnce({ rows: [{ value: "not json" }] });
        await expect(getSearchAcronyms()).resolves.toEqual([]);
    });
});

describe("findDuplicateAcronym (#291)", () => {
    it("treats case, spacing, and punctuation variants as the same acronym", async () => {
        const { findDuplicateAcronym } = await import("./searchAcronyms");
        expect(findDuplicateAcronym([{ acronym: "bg3", expansion: "a" }, { acronym: "BG-3", expansion: "b" }])).toBe("BG-3");
        expect(findDuplicateAcronym([{ acronym: "bg3", expansion: "a" }, { acronym: "gta", expansion: "b" }])).toBeNull();
    });
});

describe("saveSearchAcronyms", () => {
    it("upserts the list as JSON", async () => {
        const { saveSearchAcronyms } = await import("./searchAcronyms");
        queryMock.mockResolvedValueOnce({ rows: [] });
        await saveSearchAcronyms([{ acronym: "bg3", expansion: "baldur's gate" }]);
        expect(queryMock.mock.calls[0][1][1]).toBe('[{"acronym":"bg3","expansion":"baldur\'s gate"}]');
    });
});
