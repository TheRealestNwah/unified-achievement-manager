import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

vi.mock("../auth/localProfile", () => ({ getLocalProfile: vi.fn() }));

import { requireLocalHost } from "./localProfileSession";

function run(host: string | undefined) {
    const next = vi.fn();
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    requireLocalHost(4321)({ headers: { host } } as Request, res as unknown as Response, next);
    return { next, res };
}

describe("requireLocalHost (#393)", () => {
    it("serves the app's own host names", () => {
        expect(run("127.0.0.1:4321").next).toHaveBeenCalled();
        expect(run("localhost:4321").next).toHaveBeenCalled();
        expect(run("LOCALHOST:4321").next).toHaveBeenCalled();
    });

    it("turns away a page that pointed its own domain at 127.0.0.1", () => {
        for (const host of ["evil.example:4321", "127.0.0.1:9999", "127.0.0.1", undefined]) {
            const { next, res } = run(host);
            expect(next).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(421);
        }
    });
});
