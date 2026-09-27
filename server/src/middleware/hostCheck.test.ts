import { describe, expect, it } from "vitest";
import { isAllowedHost } from "./hostCheck";

describe("Host header check", () => {
    it("accepts this machine on the app's port", () => {
        expect(isAllowedHost("127.0.0.1:3000", 3000)).toBe(true);
        expect(isAllowedHost("localhost:3000", 3000)).toBe(true);
        expect(isAllowedHost("LocalHost:3000", 3000)).toBe(true);
    });

    it("accepts a request with no Host header", () => {
        expect(isAllowedHost(undefined, 3000)).toBe(true);
    });

    it("rejects other hostnames, including ones that resolve to 127.0.0.1", () => {
        expect(isAllowedHost("evil.example:3000", 3000)).toBe(false);
        expect(isAllowedHost("127.0.0.1.nip.io:3000", 3000)).toBe(false);
        expect(isAllowedHost("", 3000)).toBe(false);
    });

    it("rejects the right host on the wrong port or with no port", () => {
        expect(isAllowedHost("127.0.0.1:4000", 3000)).toBe(false);
        expect(isAllowedHost("127.0.0.1", 3000)).toBe(false);
        expect(isAllowedHost("localhost", 3000)).toBe(false);
    });
});
