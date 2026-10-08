import { describe, expect, it } from "vitest";
import { isLegacyOnlyLink } from "./gameMatcher";

describe("isLegacyOnlyLink", () => {
    it("is not legacy when there's no console variant", () => {
        expect(isLegacyOnlyLink("psn", null)).toBe(false);
        expect(isLegacyOnlyLink("xbox", null)).toBe(false);
    });

    it("rpcs3 is always legacy: every RPCS3 game is a PS3 release (see #523)", () => {
        expect(isLegacyOnlyLink("rpcs3", null)).toBe(true);
    });

    it("steam is never legacy regardless of variant", () => {
        expect(isLegacyOnlyLink("steam", "PS3")).toBe(false);
    });

    it("xbox is legacy only for the literal Xbox 360 signal", () => {
        expect(isLegacyOnlyLink("xbox", "Xbox 360")).toBe(true);
        expect(isLegacyOnlyLink("xbox", "Xbox One")).toBe(false);
    });

    it("psn is legacy when every listed platform predates PS4 (see #225)", () => {
        expect(isLegacyOnlyLink("psn", "PS3")).toBe(true);
        expect(isLegacyOnlyLink("psn", "PS3,PSVITA")).toBe(true);
    });

    it("psn is not legacy once a current-gen platform is in the list", () => {
        expect(isLegacyOnlyLink("psn", "PS3,PS4")).toBe(false);
        expect(isLegacyOnlyLink("psn", "PS5")).toBe(false);
    });
});
