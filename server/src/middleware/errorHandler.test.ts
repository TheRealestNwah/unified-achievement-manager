import { describe, expect, it, vi } from "vitest";
import { DatabaseError } from "pg";
import type { NextFunction, Request, Response } from "express";
import { errorResponse, jsonErrorHandler } from "./errorHandler";

function dbError(code: string, message: string): DatabaseError {
    const err = new DatabaseError(message, message.length, "error");
    err.code = code;
    return err;
}

describe("errorResponse", () => {
    it("turns a malformed ID into a 400 without the database's message (#336)", () => {
        const res = errorResponse(dbError("22P02", 'invalid input syntax for type uuid: "x"'));
        expect(res).toEqual({ status: 400, error: "Invalid ID" });
    });

    it("hides other database errors behind a generic 500", () => {
        const res = errorResponse(dbError("23505", "duplicate key value violates unique constraint"));
        expect(res).toEqual({ status: 500, error: "Internal server error" });
    });

    it("keeps a 4xx status an error already carries", () => {
        const err = Object.assign(new Error("Unexpected token } in JSON"), { status: 400 });
        expect(errorResponse(err)).toEqual({ status: 400, error: "Unexpected token } in JSON" });
    });

    it("passes other errors' messages through as a 500", () => {
        expect(errorResponse(new Error("Xbox token expired"))).toEqual({ status: 500, error: "Xbox token expired" });
        expect(errorResponse("nope")).toEqual({ status: 500, error: "Internal server error" });
    });
});

describe("jsonErrorHandler", () => {
    it("hands an error after the response was sent to Express instead of writing again (#408)", () => {
        const res = { headersSent: true, status: vi.fn(), json: vi.fn() };
        const next = vi.fn();
        const err = new Error("Cannot use a pool after calling end on the pool");
        jsonErrorHandler(err, {} as Request, res as unknown as Response, next as NextFunction);
        expect(next).toHaveBeenCalledWith(err);
        expect(res.status).not.toHaveBeenCalled();
    });
});
