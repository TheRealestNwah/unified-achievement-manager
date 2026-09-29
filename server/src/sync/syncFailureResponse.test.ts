import { describe, expect, it, vi } from "vitest";
import type { NextFunction, Response } from "express";
import { sendSyncFailure } from "./syncFailureResponse";

function fakeRes() {
    const res = { status: vi.fn(), json: vi.fn() };
    res.status.mockReturnValue(res);
    return res;
}

describe("sendSyncFailure (#424)", () => {
    it("answers with the same explanation Settings shows later", () => {
        const res = fakeRes();
        const next = vi.fn();
        sendSyncFailure("psn", new Error("PlayStation Network login expired (token refresh refused with 400)"), res as unknown as Response, next as NextFunction);
        expect(res.status).toHaveBeenCalledWith(502);
        expect(res.json).toHaveBeenCalledWith({
            error: "Your PlayStation Network login has expired. Use Update login… in Settings to reconnect.",
        });
        expect(next).not.toHaveBeenCalled();
    });

    it("hands errors it can't explain to the error handler", () => {
        const res = fakeRes();
        const next = vi.fn();
        const err = new Error("Invalid OpenXBL API key");
        sendSyncFailure("xbox", err, res as unknown as Response, next as NextFunction);
        expect(next).toHaveBeenCalledWith(err);
        expect(res.status).not.toHaveBeenCalled();
    });
});
