import https from "https";
import type { IncomingHttpHeaders } from "http";
import { URL } from "url";

// Sony has no public developer API. This client mirrors the reverse-engineered
// flow used by the community reference library (psn-api) - endpoints and the
// client_id/secret pair below were confirmed against its source directly
// rather than assumed, since there's no official documentation to check
// against. See docs/data-model.md for how PSN's tier fits into scoring.

const AUTH_BASE_URL = "https://ca.account.sony.com/api/authz/v3/oauth";
const TROPHY_BASE_URL = "https://m.np.playstation.com/api/trophy";

// Public OAuth client used by Sony's own first-party mobile app - not a
// secret we're leaking, it's the same constant every PSN trophy tool uses.
const CLIENT_BASIC_AUTH = "Basic MDk1MTUxNTktNzIzNy00MzcwLTliNDAtMzgwNmU2N2MwODkxOnVjUGprYTV0bnRCMktxc1A=";
const OAUTH_REDIRECT_URI = "com.scee.psxandroid.scecompcall://redirect";

export class PsnApiError extends Error {
    constructor(public status: number, message: string) {
        super(message);
    }
}

// Node's built-in https module is used deliberately (not fetch) - the NPSSO
// exchange needs to read a Location header off a manually-handled redirect,
// and https.request gives that directly without any fetch-spec redirect
// mode subtleties to worry about (see the Xbox client for why that caution
// is warranted against unofficial/quirky servers).
function request(options: https.RequestOptions, body?: string): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
        });
        req.on("error", reject);
        if (body) req.write(body);
        req.end();
    });
}

export async function exchangeNpssoForAccessCode(npsso: string): Promise<string> {
    const query = new URLSearchParams({
        access_type: "offline",
        client_id: "09515159-7237-4370-9b40-3806e67c0891",
        redirect_uri: OAUTH_REDIRECT_URI,
        response_type: "code",
        scope: "psn:mobile.v2.core psn:clientapp",
    }).toString();

    const url = new URL(`${AUTH_BASE_URL}/authorize?${query}`);
    const res = await request({
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: "GET",
        headers: { Cookie: `npsso=${npsso}` },
    });

    const location = res.headers.location;
    if (res.status !== 302 || !location || !location.includes("?code=")) {
        throw new PsnApiError(401, "Invalid or expired NPSSO token - get a fresh one from https://ca.account.sony.com/api/v1/ssocookie while logged into playstation.com");
    }

    const code = new URLSearchParams(location.split("?")[1]).get("code");
    if (!code) throw new PsnApiError(401, "PSN did not return an access code for this NPSSO token");
    return code;
}

export interface PsnTokens {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    idToken: string;
}

async function exchangeForTokens(body: URLSearchParams): Promise<PsnTokens> {
    const url = new URL(`${AUTH_BASE_URL}/token`);
    const payload = body.toString();
    const res = await request(
        {
            hostname: url.hostname,
            path: url.pathname,
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "Content-Length": Buffer.byteLength(payload),
                Authorization: CLIENT_BASIC_AUTH,
            },
        },
        payload
    );

    if (res.status !== 200) {
        throw new PsnApiError(res.status, `PSN token exchange failed: ${res.status}`);
    }
    const json = JSON.parse(res.body);
    return {
        accessToken: json.access_token,
        refreshToken: json.refresh_token,
        expiresIn: json.expires_in,
        idToken: json.id_token,
    };
}

// The id_token (a JWT, requested via token_format=jwt) carries the account's
// online_id and numeric account id (sub) directly in its payload - no extra
// profile API call needed. Note: the profile endpoint that would otherwise
// provide this rejects "me" as an accountId (confirmed against a live
// token: "Bad Request (path: accountId)"), unlike the trophy endpoints.
export function decodeIdToken(idToken: string): { onlineId: string; accountId: string } {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString());
    return { onlineId: payload.online_id, accountId: payload.sub };
}

export function exchangeAccessCodeForTokens(accessCode: string): Promise<PsnTokens> {
    return exchangeForTokens(
        new URLSearchParams({
            code: accessCode,
            redirect_uri: OAUTH_REDIRECT_URI,
            grant_type: "authorization_code",
            token_format: "jwt",
        })
    );
}

// PSN access tokens are short-lived (roughly an hour), so sync always
// refreshes first rather than tracking expiry.
export function exchangeRefreshTokenForTokens(refreshToken: string): Promise<PsnTokens> {
    return exchangeForTokens(
        new URLSearchParams({
            refresh_token: refreshToken,
            grant_type: "refresh_token",
            token_format: "jwt",
            scope: "psn:mobile.v2.core psn:clientapp",
        })
    );
}

// Sony's trophy API has brief outages (503s a couple of minutes apart, see
// #318), and one failed call on any single title would otherwise abort the
// whole sync. Transient statuses and dropped connections are retried with
// backoff, honoring Retry-After up to a cap.
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;
const MAX_RETRY_AFTER_MS = 30_000;
// Mutable so tests don't have to wait out real backoff.
export const psnRetry = { baseDelayMs: 2_000 };

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(attempt: number, retryAfter: string | string[] | undefined): number {
    const seconds = Number(Array.isArray(retryAfter) ? retryAfter[0] : retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
    return psnRetry.baseDelayMs * 2 ** (attempt - 1);
}

async function apiGet<T>(accessToken: string, url: string): Promise<T> {
    const parsed = new URL(url);
    for (let attempt = 1; ; attempt++) {
        let res: Awaited<ReturnType<typeof request>>;
        try {
            res = await request({
                hostname: parsed.hostname,
                path: parsed.pathname + parsed.search,
                method: "GET",
                headers: { Authorization: `Bearer ${accessToken}` },
            });
        } catch (err) {
            if (attempt < MAX_ATTEMPTS) {
                await sleep(retryDelayMs(attempt, undefined));
                continue;
            }
            throw new PsnApiError(0, `Couldn't reach PlayStation Network (${err instanceof Error ? err.message : String(err)}). Check your connection and try again.`);
        }

        if (TRANSIENT_STATUSES.has(res.status) && attempt < MAX_ATTEMPTS) {
            await sleep(retryDelayMs(attempt, res.headers["retry-after"]));
            continue;
        }
        if (res.status === 401) throw new PsnApiError(401, "PSN access token was rejected");
        if (TRANSIENT_STATUSES.has(res.status)) {
            console.warn(`PSN API ${parsed.pathname} still failing after ${MAX_ATTEMPTS} attempts: ${res.status}`);
            throw new PsnApiError(
                res.status,
                res.status === 429
                    ? "PlayStation Network is rate-limiting requests right now. Try again in a few minutes."
                    : `PlayStation Network is temporarily unavailable (${res.status}). Try again in a few minutes.`
            );
        }
        if (res.status < 200 || res.status >= 300) {
            throw new PsnApiError(res.status, `PSN API ${parsed.pathname} failed: ${res.status}`);
        }
        return JSON.parse(res.body) as T;
    }
}


export interface PsnTitle {
    npCommunicationId: string;
    npServiceName: "trophy" | "trophy2";
    trophyTitleName: string;
    trophyTitleIconUrl?: string;
    // Comma-separated, e.g. "PS5", "PS3,PSVITA,PS4" for a cross-gen title -
    // one trophy list can span multiple platforms rather than being split
    // per generation. Confirmed live against a real account (see #19).
    trophyTitlePlatform?: string;
}

export async function getUserTitles(accessToken: string): Promise<PsnTitle[]> {
    const titles: PsnTitle[] = [];
    let offset = 0;

    for (;;) {
        const page = await apiGet<{
            trophyTitles: PsnTitle[];
            totalItemCount: number;
            nextOffset?: number;
        }>(accessToken, `${TROPHY_BASE_URL}/v1/users/me/trophyTitles?limit=800&offset=${offset}`);
        titles.push(...page.trophyTitles);
        if (!page.nextOffset || page.nextOffset <= offset) break;
        offset = page.nextOffset;
    }

    return titles;
}

export interface PsnTrophyDefinition {
    trophyId: number;
    trophyType: "bronze" | "silver" | "gold" | "platinum";
    trophyName?: string;
    trophyDetail?: string;
    trophyHidden: boolean;
    trophyIconUrl?: string;
}

export async function getTitleTrophies(
    accessToken: string,
    npCommunicationId: string,
    npServiceName: string
): Promise<PsnTrophyDefinition[]> {
    const data = await apiGet<{ trophies: PsnTrophyDefinition[] }>(
        accessToken,
        `${TROPHY_BASE_URL}/v1/npCommunicationIds/${npCommunicationId}/trophyGroups/all/trophies?npServiceName=${npServiceName}`
    );
    return data.trophies;
}

export interface PsnEarnedTrophy {
    trophyId: number;
    earned?: boolean;
    earnedDateTime?: string;
    trophyEarnedRate?: string;
}

export async function getUserTrophiesEarnedForTitle(
    accessToken: string,
    npCommunicationId: string,
    npServiceName: string
): Promise<PsnEarnedTrophy[]> {
    const data = await apiGet<{ trophies: PsnEarnedTrophy[] }>(
        accessToken,
        `${TROPHY_BASE_URL}/v1/users/me/npCommunicationIds/${npCommunicationId}/trophyGroups/all/trophies?npServiceName=${npServiceName}`
    );
    return data.trophies;
}
