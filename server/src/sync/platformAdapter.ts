import { NativeTier } from "./canonicalStore";

// What one platform supplies to the sync pipeline (see GLOSSARY.md): the
// games a linked account owns, and each owned game's achievement list.
// Everything that writes to the library - unlocks, revocations, ownership,
// tiers, reconciliation, change markers, credentials - is the pipeline's job,
// so an adapter only talks to its platform.

// The stored linked account, with credentials already decrypted.
export interface LinkedAccount {
    platformAccountId: string;
    accessToken: string | null;
    refreshToken: string | null;
    // Only RPCS3 has one: the RPCS3 folder on this computer (see #522).
    localFolder: string | null;
}

export interface Credentials {
    accessToken: string;
    refreshToken: string;
}

// `details` is whatever the adapter learned about the game while listing it
// (a name, a cover, a folder). The pipeline never reads it; it hands the game
// back to fetchAchievementList with its details, so an adapter doesn't need a
// side table filled by listOwnedGames. Adapters that need nothing set it to
// undefined.
export interface OwnedGame<Details = undefined> {
    platformGameId: string;
    details: Details;
    // Changes only when the game's achievements might have. When it matches
    // the marker saved after the last full recording, the game is skipped.
    changeMarker?: string;
    // False when the platform already says the game has no achievements, so
    // it's never fetched. It still counts as owned.
    hasAchievements?: boolean;
}

export interface AchievementEntry {
    id: string;
    name: string;
    description?: string;
    // Share of players who unlocked it, 0-100, when the platform reports one.
    rarity?: number;
    nativeTier?: NativeTier;
    iconUrl?: string;
    unlocked: boolean;
    // null when the platform gives no trustworthy time (see #423).
    unlockedAt: Date | null;
}

export type AchievementListResult =
    | {
          kind: "achievements";
          title: string;
          coverImageUrl?: string;
          consoleVariant?: string;
          achievements: AchievementEntry[];
      }
    // The game has no achievements: its change marker is still saved.
    | { kind: "none" }
    // Couldn't be read this time (e.g. a file being written). Logged and
    // left alone; the game still counts as owned.
    | { kind: "skip"; reason: string };

// One sync's connection to a platform.
export interface PlatformSession<Details = undefined> {
    // Set when connecting rotated the account's tokens; the pipeline saves them.
    refreshedCredentials?: Credentials;
    listOwnedGames(): Promise<OwnedGame<Details>[]>;
    // Called only with games this session's listOwnedGames returned.
    fetchAchievementList(game: OwnedGame<Details>): Promise<AchievementListResult>;
}

export interface PlatformAdapter<Details = undefined> {
    platformId: string;
    // Throwing here, or from either session method, aborts the whole sync.
    connect(account: LinkedAccount): Promise<PlatformSession<Details>>;
}

// Any platform's adapter, whatever its details: what the pipeline and the
// adapter registry work with.
export type AnyPlatformAdapter = PlatformAdapter<unknown>;
