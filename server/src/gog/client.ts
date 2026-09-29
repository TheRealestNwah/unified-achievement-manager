// GOG has no official public API. This client follows the community
// reverse-engineered documentation (https://github.com/Yepoleb/gogapidocs),
// the same discipline as PSN/Xbox's clients in this codebase - endpoints,
// client_id/secret and response shapes below were checked against that
// documentation directly rather than assumed. Unlike PSN/Xbox, this has not
// yet been live-verified against a real GOG account (see #31) - flagged
// clearly in the PR that introduces this file.

const AUTH_BASE_URL = "https://auth.gog.com";
const EMBED_BASE_URL = "https://embed.gog.com";
const API_BASE_URL = "https://api.gog.com";
const GAMEPLAY_BASE_URL = "https://gameplay.gog.com";
const USERS_BASE_URL = "https://users.gog.com";

// Public OAuth client used by GOG Galaxy itself - not a secret we're leaking,
// it's the same constant every third-party GOG tool (gogapidocs, Heroic,
// lgogdownloader) uses, same situation as PSN's CLIENT_BASIC_AUTH.
const CLIENT_ID = "46899977096215655";
const CLIENT_SECRET = "9d85c43b1482497dbbce61f6e4aa173a433796eeae2ca8c5f6129f2dc4de46d9";

// GOG's documented redirect_uri for the "client" auth layout. There's no
// callback we control to receive this server-side - the user completes login
// in their own browser, GOG redirects here (a page on GOG's own domain), and
// they copy the "code" query param out of the resulting URL and paste it into
// this app, the same paste-a-value-obtained-elsewhere pattern PSN's NPSSO
// flow already uses.
const REDIRECT_URI = "https://embed.gog.com/on_login_success?origin=client";

export const GOG_LOGIN_URL = `${AUTH_BASE_URL}/auth?${new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    layout: "client2",
}).toString()}`;

export class GogApiError extends Error {
    constructor(public status: number, message: string) {
        super(message);
    }
}

async function get<T>(baseUrl: string, path: string, accessToken?: string): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, {
        headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
    });
    if (res.status === 401) throw new GogApiError(401, "GOG access token was rejected");
    if (!res.ok) {
        throw new GogApiError(res.status, `GOG API ${path} failed: ${res.status}`);
    }
    return res.json() as Promise<T>;
}

export interface GogTokens {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    userId: string;
}

// Shared by the pasted login code and the saved refresh token, which fail for
// different reasons, so each caller says what a refusal means (see #424).
async function exchangeForTokens(params: Record<string, string>, refused: string): Promise<GogTokens> {
    const query = new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        ...params,
    }).toString();

    const res = await fetch(`${AUTH_BASE_URL}/token?${query}`);
    if (!res.ok) {
        if (res.status === 400 || res.status === 401) throw new GogApiError(401, refused);
        throw new GogApiError(res.status, `GOG token request failed: ${res.status}`);
    }
    const json = (await res.json()) as {
        access_token: string;
        refresh_token: string;
        expires_in: number;
        user_id: string;
    };
    return {
        accessToken: json.access_token,
        refreshToken: json.refresh_token,
        expiresIn: json.expires_in,
        userId: json.user_id,
    };
}

// The one-time "code" pasted from the redirect URL after logging in at
// GOG_LOGIN_URL - see REDIRECT_URI above for why there's no direct callback.
export function exchangeCodeForTokens(code: string): Promise<GogTokens> {
    return exchangeForTokens(
        { grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI },
        "GOG rejected that login code - it may have expired (they're single-use and short-lived)."
    );
}

// GOG access tokens last about an hour (per the auth response's expires_in),
// so sync always refreshes first rather than tracking expiry, same as PSN.
export function exchangeRefreshTokenForTokens(refreshToken: string): Promise<GogTokens> {
    return exchangeForTokens({ grant_type: "refresh_token", refresh_token: refreshToken }, "GOG login expired (token refresh refused)");
}

export async function getOwnedGameIds(accessToken: string): Promise<string[]> {
    const data = await get<{ owned: number[] }>(EMBED_BASE_URL, "/user/data/games", accessToken);
    return data.owned.map(String);
}

// Public, unauthenticated - the token exchange only returns a numeric
// user_id, no username, so this fills in a display name for the account.
export async function getUsername(userId: string): Promise<string> {
    const data = await get<{ username: string }>(USERS_BASE_URL, `/users/${userId}`);
    return data.username;
}

export interface GogProduct {
    title: string;
    coverImageUrl?: string;
}

// Public, unauthenticated product metadata - GOG's per-user library listing
// only gives back IDs (see getOwnedGameIds), not titles/art.
export async function getProduct(productId: string): Promise<GogProduct> {
    const data = await get<{ title: string; images?: { logo2x?: string; logo?: string } }>(
        API_BASE_URL,
        `/products/${productId}`
    );
    const image = data.images?.logo2x ?? data.images?.logo;
    // GOG's image URLs come back protocol-relative ("//images-3.gog.com/...").
    return { title: data.title, coverImageUrl: image ? `https:${image}` : undefined };
}

export interface GogAchievement {
    id: string;
    key: string;
    name: string;
    description?: string;
    isUnlocked: boolean;
    unlockedAt?: string;
    iconUrl?: string;
}

// Most of GOG's older DRM-free catalog predates achievement support. Mirrors
// Steam's getPlayerAchievements here (steam/client.ts): a game with no
// achievements schema at all is expected to error rather than come back as
// an empty list, so that's treated the same as "no achievements" instead of
// failing the whole sync over one title.
export async function getAchievementsForGame(
    accessToken: string,
    productId: string,
    userId: string
): Promise<GogAchievement[]> {
    try {
        const data = await get<{
            items: Array<{
                achievement_id: string;
                achievement_key: string;
                name: string;
                description?: string;
                image_url_unlocked?: string;
                image_url_locked?: string;
                date_unlocked: string | null;
            }>;
        }>(GAMEPLAY_BASE_URL, `/clients/${productId}/users/${userId}/achievements`, accessToken);

        return data.items.map((a) => ({
            id: a.achievement_id,
            key: a.achievement_key,
            name: a.name,
            description: a.description,
            isUnlocked: a.date_unlocked !== null,
            unlockedAt: a.date_unlocked ?? undefined,
            // GOG gives a locked (silhouette) variant and an unlocked (full
            // color) variant per achievement - image_url_unlocked isn't
            // populated until someone has actually unlocked it, so an
            // achievement nobody has earned yet was always coming back with
            // no icon at all even though GOG does provide one for the locked
            // state. Falling back to the locked variant means every
            // achievement gets an icon regardless of unlock status; once
            // someone does unlock it, a later sync's opportunistic backfill
            // (see canonicalStore.getOrCreateAchievementLink) can't upgrade
            // it to the color version since icon_url is only ever backfilled
            // while still null - acceptable here since a locked-vs-unlocked
            // icon swap on an already-displayed achievement is cosmetic, not
            // a missing-icon bug.
            iconUrl: a.image_url_unlocked ?? a.image_url_locked,
        }));
    } catch (err) {
        if (err instanceof GogApiError && err.status === 401) throw err;
        return [];
    }
}
