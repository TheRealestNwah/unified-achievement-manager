import https from "https";

const BASE_URL = "https://api.xbl.io";

class XboxApiError extends Error {
    constructor(public status: number, message: string) {
        super(message);
    }
}

// Deliberately not using Node's global fetch (undici) here: against
// api.xbl.io it reproducibly gets back an HTTP 200 wrapping a `code: 400`
// error body, while an identical request via Node's https module or curl
// succeeds - some incompatibility between undici's request internals and
// OpenXBL's server, not a real error. Steam's client is unaffected, so only
// this module needs the workaround.
function rawGet(apiKey: string, path: string): Promise<{ status: number; body: string; retryAfter?: string }> {
    return new Promise((resolve, reject) => {
        https
            .get(`${BASE_URL}${path}`, { headers: { "X-Authorization": apiKey } }, (res) => {
                let data = "";
                res.on("data", (chunk) => (data += chunk));
                res.on("end", () =>
                    resolve({
                        status: res.statusCode ?? 0,
                        body: data,
                        retryAfter: res.headers["retry-after"] as string | undefined,
                    })
                );
            })
            .on("error", reject);
    });
}

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

const MAX_RETRIES = 3;

// OpenXBL is a thin proxy in front of Microsoft's own Xbox Live rate limits
// (per their docs: tight per-service burst/sustain windows), so a real sync
// making dozens of calls can legitimately hit a 429 mid-run. Retry with
// backoff honoring Retry-After rather than failing the whole sync.
async function get<T>(apiKey: string, path: string, attempt = 1): Promise<T> {
    const res = await rawGet(apiKey, path);

    if (res.status === 429 && attempt <= MAX_RETRIES) {
        const waitSeconds = res.retryAfter ? Number(res.retryAfter) : attempt * 2;
        await sleep(waitSeconds * 1000);
        return get<T>(apiKey, path, attempt + 1);
    }

    if (res.status === 401) throw new XboxApiError(401, "Invalid OpenXBL API key");
    if (res.status < 200 || res.status >= 300) {
        throw new XboxApiError(res.status, `OpenXBL ${path} failed: ${res.status}`);
    }

    const body = JSON.parse(res.body) as { content: T; code: number; message?: string };
    if (body.code !== 200) {
        throw new XboxApiError(body.code, body.message ?? `OpenXBL ${path} returned code ${body.code}`);
    }
    return body.content;
}

export { XboxApiError };

export interface XboxAccount {
    xuid: string;
    gamertag: string;
    gamerscore: number;
}

export async function getAccount(apiKey: string): Promise<XboxAccount> {
    const content = await get<{
        profileUsers: Array<{ id: string; settings: Array<{ id: string; value: string }> }>;
    }>(apiKey, "/v2/account");
    const profile = content.profileUsers[0];
    const setting = (id: string) => profile.settings.find((s) => s.id === id)?.value ?? "";
    return {
        xuid: profile.id,
        gamertag: setting("Gamertag"),
        gamerscore: Number(setting("Gamerscore") || 0),
    };
}

export interface XboxTitleSummary {
    titleId: string;
    name: string;
    totalAchievements: number;
    coverImageUrl?: string;
    // A fingerprint of this title's progress - total and unlocked counts,
    // gamerscore, last played - or undefined when OpenXBL left all of the
    // user-side fields out, in which case sync can't tell it's unchanged and
    // always fetches it.
    progress?: string;
}

// /v2/achievements ("achievements grouped by title") actually returns the
// same title-with-progress-summary shape as /v2/titles - no per-achievement
// detail despite what the docs' example implies. Use it to find which titles
// have achievements worth fetching individually, and which of those changed.
export async function getTitles(apiKey: string): Promise<XboxTitleSummary[]> {
    const content = await get<{
        titles: Array<{
            titleId: string;
            name: string;
            achievement?: { totalAchievements: number; currentAchievements?: number; currentGamerscore?: number };
            titleHistory?: { lastTimePlayed?: string };
            displayImage?: string;
        }>;
    }>(apiKey, "/v2/achievements");

    return content.titles.map((t) => {
        const parts = [t.achievement?.currentAchievements, t.achievement?.currentGamerscore, t.titleHistory?.lastTimePlayed];
        const totalAchievements = t.achievement?.totalAchievements ?? 0;
        return {
            titleId: t.titleId,
            name: t.name,
            totalAchievements,
            coverImageUrl: t.displayImage,
            // The total is in there too, so achievements added by an update
            // or DLC get fetched before any of them is unlocked.
            progress: parts.every((p) => p === undefined) ? undefined : [totalAchievements, ...parts].map((p) => p ?? "").join("|"),
        };
    });
}

export interface XboxAchievement {
    id: string;
    name: string;
    description: string;
    isUnlocked: boolean;
    timeUnlocked?: string;
    gamerscore: number;
    rarityPercent?: number;
    iconUrl?: string;
}

interface RawXboxAchievement {
    id: string;
    name: string;
    description: string;
    progressState: string;
    progression?: { timeUnlocked?: string };
    rewards?: Array<{ type: string; value: string }>;
    rarity?: { currentPercentage?: number };
    mediaAssets?: Array<{ type: string; url: string }>;
}

function mapAchievement(a: RawXboxAchievement): XboxAchievement {
    const gamerscoreReward = a.rewards?.find((r) => r.type === "Gamerscore");
    return {
        id: a.id,
        name: a.name,
        description: a.description,
        isUnlocked: a.progressState === "Achieved",
        timeUnlocked: a.progression?.timeUnlocked,
        gamerscore: gamerscoreReward ? Number(gamerscoreReward.value) : 0,
        rarityPercent: a.rarity?.currentPercentage,
        iconUrl: a.mediaAssets?.find((m) => m.type === "Icon")?.url,
    };
}

// Paginated (32/page by default on Xbox's side) - follow pagingInfo.continuationToken
// until it comes back null.
export async function getAchievementsForTitle(apiKey: string, titleId: string): Promise<XboxAchievement[]> {
    const results: XboxAchievement[] = [];
    let continuationToken: string | null = null;

    do {
        const query = continuationToken ? `?continuationToken=${continuationToken}` : "";
        const content: { achievements: RawXboxAchievement[]; pagingInfo?: { continuationToken: string | null } } =
            await get(apiKey, `/v2/achievements/title/${titleId}${query}`);
        results.push(...content.achievements.map(mapAchievement));
        continuationToken = content.pagingInfo?.continuationToken ?? null;
    } while (continuationToken);

    return results;
}

interface RawX360Achievement {
    id: number;
    titleId?: number;
    imageId?: number;
    name: string;
    description: string;
    unlocked: boolean;
    timeUnlocked?: string;
    gamerscore: number;
    rarity?: { currentPercentage?: number };
    mediaAssets?: Array<{ type: string; url: string }>;
}

interface X360Page {
    achievements: RawX360Achievement[];
    pagingInfo?: { continuationToken: string | null };
}

async function getAllPages(apiKey: string, path: string): Promise<RawX360Achievement[]> {
    const results: RawX360Achievement[] = [];
    let continuationToken: string | null = null;

    do {
        const query: string = continuationToken ? `?continuationToken=${continuationToken}` : "";
        const page: X360Page = await get<X360Page>(apiKey, `${path}${query}`);
        results.push(...page.achievements);
        continuationToken = page.pagingInfo?.continuationToken ?? null;
    } while (continuationToken);

    return results;
}

// The modern /v2/achievements/title endpoint returns an empty list (not an
// error) for classic Xbox 360 titles - they use a separate legacy contract
// split across two endpoints, mirroring the schema+status split used for
// Steam and PSN elsewhere in this codebase:
//   - /v2/achievements/player/{xuid}/title/{id} returns the FULL catalog
//     (definitions: name/description/gamerscore/rarity) but its `unlocked`
//     and `timeUnlocked` fields are bogus placeholders (confirmed against a
//     live account: always false / a fixed 2002 date, which predates the
//     Xbox 360 by three years) - it's a schema call despite the per-player
//     path shape.
//   - /v2/achievements/x360/{xuid}/title/{id} has the real per-player earned
//     status, but only returns achievements actually earned - not the full
//     catalog.
// Neither alone is enough; this merges both by achievement id.
export async function getX360AchievementsForTitle(
    apiKey: string,
    xuid: string,
    titleId: string
): Promise<XboxAchievement[]> {
    const [definitions, earned] = await Promise.all([
        getAllPages(apiKey, `/v2/achievements/player/${xuid}/title/${titleId}`),
        getAllPages(apiKey, `/v2/achievements/x360/${xuid}/title/${titleId}`),
    ]);
    const earnedById = new Map(earned.map((a) => [a.id, a]));

    return definitions.map((def) => {
        const status = earnedById.get(def.id);
        return {
            id: String(def.id),
            name: def.name,
            description: def.description,
            isUnlocked: status?.unlocked ?? false,
            timeUnlocked: plausibleUnlockTime(status?.timeUnlocked),
            gamerscore: def.gamerscore,
            rarityPercent: (status ?? def).rarity?.currentPercentage,
            iconUrl: def.mediaAssets?.find((m) => m.type === "Icon")?.url ?? x360IconUrl(def.titleId ?? Number(titleId), def.imageId),
        };
    });
}

// The legacy definitions endpoint has no mediaAssets (confirmed against a
// live account, see #165 - #151 assumed it did), only an imageId. Xbox
// Live's classic achievement tile URL is built from the title id and image
// id, both in lowercase hex.
function x360IconUrl(titleId: number, imageId: number | undefined): string | undefined {
    if (!Number.isInteger(titleId) || titleId <= 0 || imageId === undefined) return undefined;
    return `https://image-ssl.xboxlive.com/global/t.${titleId.toString(16)}/ach/0/${imageId.toString(16)}`;
}

// Even the "real" per-player earned endpoint above isn't fully trustworthy
// for this one field: confirmed against a live account, some genuinely
// earned achievements come back with timeUnlocked set to a bogus sentinel
// (1752-12-31) instead of a real date - centuries before Xbox existed. See
// #41. Treated as absent rather than trusted, so callers fall back to their
// own default (xbox/sync.ts uses now()) same as when the platform gives no
// timestamp at all.
const XBOX_360_LAUNCH = Date.UTC(2005, 10, 22); // Nov 22, 2005

function plausibleUnlockTime(iso: string | undefined): string | undefined {
    if (!iso) return undefined;
    const t = new Date(iso).getTime();
    return !Number.isNaN(t) && t >= XBOX_360_LAUNCH ? iso : undefined;
}

export interface XboxMarketplaceProduct {
    productId: string;
    title: string;
    type: string;
}

// Used to look up a title without any user having linked/synced Xbox for it
// (see matching/xboxCatalogEnrichment.ts) - OpenXBL's own docs document this
// exact search -> titleid -> achievements chain, confirmed live against a
// title this account has never played (#50).
export async function searchMarketplace(apiKey: string, term: string): Promise<XboxMarketplaceProduct[]> {
    const content = await get<{
        Results: Array<{ Products: Array<{ ProductId: string; Title: string; Type: string }> }>;
    }>(apiKey, `/v2/marketplace/autosuggest?q=${encodeURIComponent(term)}`);
    return content.Results.flatMap((r) => r.Products).map((p) => ({
        productId: p.ProductId,
        title: p.Title,
        type: p.Type,
    }));
}

// Resolves a Microsoft Store product ID to the title ID the achievements
// endpoints expect. Some Store products carry no Xbox title ID at all
// (add-ons, bundles, PC-only listings) - OpenXBL's own docs use this exact
// case as their example (Halo Infinite is listed twice, once with a title
// ID and once without), so that's treated as "no match" rather than an
// error.
export async function getTitleIdForProduct(apiKey: string, productId: string): Promise<string | undefined> {
    try {
        const content = await get<{ titleId: string }>(apiKey, `/v2/marketplace/titleid/${productId}`);
        return content.titleId;
    } catch (err) {
        if (err instanceof XboxApiError && err.status === 404) return undefined;
        throw err;
    }
}
