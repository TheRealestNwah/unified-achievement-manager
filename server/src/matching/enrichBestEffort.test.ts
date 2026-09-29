import { describe, expect, it, vi } from "vitest";
import { enrichBestEffort } from "./index";

describe("enrichBestEffort (#435)", () => {
    it("passes a successful enrichment's result through", async () => {
        expect(await enrichBestEffort("Steam", async () => ({ gamesEnriched: 4 }))).toEqual({ gamesEnriched: 4 });
    });

    it("logs a failed enrichment and carries on with nothing enriched", async () => {
        const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const err = Object.assign(new Error("OpenXBL /v2/marketplace failed: 401"), { status: 401 });
        const result = await enrichBestEffort("Xbox", () => Promise.reject(err));
        expect(result).toEqual({ gamesEnriched: 0 });
        expect(log).toHaveBeenCalledWith("Xbox catalog enrichment stopped for this run:", err);
        log.mockRestore();
    });
});
