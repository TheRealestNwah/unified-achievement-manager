import { EventEmitter } from "events";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The client talks to Sony through https.request (not fetch - see client.ts),
// so the fake sits at that layer: each queued response answers the next call.
const { responses, requests } = vi.hoisted(() => ({
    responses: [] as Array<{ status: number; body?: unknown; headers?: Record<string, string> }>,
    requests: [] as Array<{ method?: string; path?: string; body?: string }>,
}));

vi.mock("https", () => {
    const request = (options: { method?: string; path?: string }, callback: (res: EventEmitter) => void) => {
        const recorded: { method?: string; path?: string; body?: string } = { method: options.method, path: options.path };
        requests.push(recorded);
        return {
            on: () => undefined,
            write: (body: string) => {
                recorded.body = body;
            },
            end: () => {
                const next = responses.shift();
                if (!next) throw new Error(`Unexpected PSN request: ${options.path}`);
                const res = Object.assign(new EventEmitter(), { statusCode: next.status, headers: next.headers ?? {} });
                callback(res);
                setImmediate(() => {
                    if (next.body !== undefined) res.emit("data", typeof next.body === "string" ? next.body : JSON.stringify(next.body));
                    res.emit("end");
                });
            },
        };
    };
    return { default: { request }, request };
});

import {
    decodeIdToken,
    exchangeAccessCodeForTokens,
    exchangeNpssoForAccessCode,
    getUserTitles,
    getUserTrophiesEarnedForTitle,
    PsnApiError,
    psnRetry,
} from "./client";

beforeEach(() => {
    psnRetry.baseDelayMs = 0;
    responses.length = 0;
    requests.length = 0;
});

describe("PSN client response parsing", () => {
    it("pulls the access code out of the authorize redirect's Location header", async () => {
        responses.push({ status: 302, headers: { location: "com.scee.psxandroid.scecompcall://redirect/?code=v3.ABCDEF&cid=123" } });
        await expect(exchangeNpssoForAccessCode("npsso")).resolves.toBe("v3.ABCDEF");
    });

    it("rejects an NPSSO token that doesn't redirect with a code", async () => {
        responses.push({ status: 302, headers: { location: "com.scee.psxandroid.scecompcall://redirect/?error=login_required" } });
        const err = await exchangeNpssoForAccessCode("expired").catch((e) => e);
        expect(err).toBeInstanceOf(PsnApiError);
        expect(err.status).toBe(401);
    });

    it("maps the token response and posts a JWT token request", async () => {
        responses.push({ status: 200, body: { access_token: "access", refresh_token: "refresh", expires_in: 3599, id_token: "id" } });
        await expect(exchangeAccessCodeForTokens("code")).resolves.toEqual({
            accessToken: "access",
            refreshToken: "refresh",
            expiresIn: 3599,
            idToken: "id",
        });
        expect(requests[0].method).toBe("POST");
        expect(new URLSearchParams(requests[0].body).get("token_format")).toBe("jwt");
    });

    it("surfaces a failed token exchange with its status", async () => {
        responses.push({ status: 400, body: { error: "invalid_grant" } });
        await expect(exchangeAccessCodeForTokens("code")).rejects.toMatchObject({ status: 400 });
    });

    it("reads the online id and account id from the id_token payload", () => {
        const payload = Buffer.from(JSON.stringify({ online_id: "TrophyHunter", sub: "1234567890123456789" })).toString("base64url");
        expect(decodeIdToken(`header.${payload}.signature`)).toEqual({ onlineId: "TrophyHunter", accountId: "1234567890123456789" });
    });

    it("pages through trophy titles until nextOffset is absent", async () => {
        const title = (id: string) => ({ npCommunicationId: id, npServiceName: "trophy2", trophyTitleName: id, trophyTitlePlatform: "PS5" });
        responses.push({ status: 200, body: { trophyTitles: [title("NPWR1")], totalItemCount: 2, nextOffset: 800 } });
        responses.push({ status: 200, body: { trophyTitles: [title("NPWR2")], totalItemCount: 2 } });

        const titles = await getUserTitles("access");
        expect(titles.map((t) => t.npCommunicationId)).toEqual(["NPWR1", "NPWR2"]);
        expect(requests.map((r) => r.path)).toEqual([
            "/api/trophy/v1/users/me/trophyTitles?limit=800&offset=0",
            "/api/trophy/v1/users/me/trophyTitles?limit=800&offset=800",
        ]);
    });

    it("stops paging if nextOffset does not advance", async () => {
        responses.push({ status: 200, body: { trophyTitles: [], totalItemCount: 0, nextOffset: 0 } });
        await expect(getUserTitles("access")).resolves.toEqual([]);
        expect(requests).toHaveLength(1);
    });

    it("maps a rejected access token to a 401", async () => {
        responses.push({ status: 401, body: {} });
        await expect(getUserTrophiesEarnedForTitle("expired", "NPWR1", "trophy2")).rejects.toMatchObject({
            status: 401,
            message: "PSN access token was rejected",
        });
    });
});

describe("PSN client transient failures (see #318)", () => {
    const titlesPage = { trophyTitles: [], totalItemCount: 0 };

    it("retries a 503 and succeeds once Sony answers", async () => {
        responses.push({ status: 503 }, { status: 502 }, { status: 200, body: titlesPage });
        await expect(getUserTitles("access")).resolves.toEqual([]);
        expect(requests).toHaveLength(3);
    });

    it("gives up after four attempts with a plain-language message", async () => {
        responses.push({ status: 503 }, { status: 503 }, { status: 503 }, { status: 503 });
        await expect(getUserTitles("access")).rejects.toMatchObject({
            status: 503,
            message: "PlayStation Network is temporarily unavailable (503). Try again in a few minutes.",
        });
        expect(requests).toHaveLength(4);
    });

    it("honors Retry-After on a 429", async () => {
        responses.push({ status: 429, headers: { "retry-after": "0" } }, { status: 200, body: titlesPage });
        await expect(getUserTitles("access")).resolves.toEqual([]);
        expect(requests).toHaveLength(2);
    });

    it("doesn't retry a non-transient failure", async () => {
        responses.push({ status: 404 });
        await expect(getUserTitles("access")).rejects.toMatchObject({ status: 404 });
        expect(requests).toHaveLength(1);
    });
});
