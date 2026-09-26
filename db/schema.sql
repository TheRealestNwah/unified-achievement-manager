-- Unified Achievement Manager data model (PostgreSQL)
-- See docs/data-model.md for the reasoning behind these tables.

create extension if not exists "uuid-ossp";

-- ---------------------------------------------------------------------------
-- Sessions (connect-pg-simple)
-- ---------------------------------------------------------------------------

-- Adapted from connect-pg-simple's own recommended DDL (see its table.sql),
-- with two changes confirmed necessary against a live server, not just
-- assumed from the docs:
--   - dropped `WITH (OIDS=FALSE)` - OIDS were removed in Postgres 12+, and
--     this fails to create at all on modern Postgres with that clause left in.
--   - dropped `DEFERRABLE INITIALLY IMMEDIATE` on the primary key - the
--     library's own session-write query uses `ON CONFLICT (sid) DO UPDATE`,
--     and Postgres rejects a deferrable constraint as an ON CONFLICT arbiter
--     ("ON CONFLICT does not support deferrable unique constraints/exclusion
--     constraints as arbiters"), so every write failed until this came out.
-- Backing sessions with Postgres instead of express-session's default
-- in-memory store means a server restart (or, later, running more than one
-- server instance) doesn't silently log every signed-in user out.
create table if not exists session (
    sid    varchar collate "default" not null,
    sess   json not null,
    expire timestamp(6) not null,
    constraint session_pkey primary key (sid)
);

create index if not exists idx_session_expire on session (expire);

-- ---------------------------------------------------------------------------
-- Platforms & users
-- ---------------------------------------------------------------------------

create table if not exists platforms (
    id                text primary key,          -- 'steam' | 'xbox' | 'psn' | 'retroachievements'
    name              text not null,
    has_native_tiers  boolean not null default false  -- true only for psn today
);

-- Identity comes from whichever platform the user first signs in with
-- (Steam OpenID, etc.) rather than a separate email/password system, so
-- email is optional and username (a platform display name) isn't unique.
create table if not exists users (
    id          uuid primary key default uuid_generate_v4(),
    email       text unique,
    username    text not null,
    created_at  timestamptz not null default now()
);

-- Public profiles, the leaderboard, and compare were removed when the app
-- became a local desktop app; drop their columns from older databases.
alter table users drop column if exists is_public;
alter table users drop column if exists public_slug;

-- Install-wide settings entered through the app rather than env vars (e.g.
-- the user's own Steam Web API key, stored encrypted like other credentials).
create table if not exists app_settings (
    key         text primary key,
    value       text not null,
    updated_at  timestamptz not null default now()
);

-- One linked account per user per platform. Holds whatever the platform's
-- API needs to pull unlock data (OAuth tokens for Xbox/PSN, a public
-- SteamID64 for Steam, a username for RetroAchievements).
create table if not exists user_platform_accounts (
    id                  uuid primary key default uuid_generate_v4(),
    user_id             uuid not null references users(id) on delete cascade,
    platform_id         text not null references platforms(id),
    platform_account_id text not null,   -- steamid64 / xuid / psn account id / RA username
    display_name        text,
    access_token        text,            -- enc:v1 AES-256-GCM ciphertext; migrated by server db:encrypt-platform-credentials
    refresh_token       text,            -- enc:v1 AES-256-GCM ciphertext; migrated by server db:encrypt-platform-credentials
    linked_at           timestamptz not null default now(),
    last_synced_at      timestamptz,
    unique (user_id, platform_id),
    unique (platform_id, platform_account_id)
);

-- ---------------------------------------------------------------------------
-- Games: one canonical row per real-world game, linked out to each
-- platform's own copy of it.
-- ---------------------------------------------------------------------------

create table if not exists games (
    id               uuid primary key default uuid_generate_v4(),
    title            text not null,
    cover_image_url  text,
    created_at       timestamptz not null default now()
);

create table if not exists game_platform_links (
    id                uuid primary key default uuid_generate_v4(),
    game_id           uuid not null references games(id) on delete cascade,
    platform_id       text not null references platforms(id),
    platform_game_id  text not null,   -- steam appid / xbox title id / psn np comm id / RA game id
    platform_title    text not null,   -- raw title as the platform reports it, kept for match debugging
    -- Display-only console-generation tag (e.g. "PS5", "PS3,PSVITA,PS4") -
    -- cosmetic, doesn't affect platform_id/dispatch or scoring authority.
    -- Only populated where the source platform's API gives clean per-title
    -- generation data (PSN currently) - see #19.
    console_variant   text,
    unique (platform_id, platform_game_id)
);

-- ---------------------------------------------------------------------------
-- Achievements: one canonical row per real-world achievement, linked out to
-- each platform's copy. Scoring lives on the canonical row so a user only
-- gets credit once even if they unlocked it on two platforms.
-- ---------------------------------------------------------------------------

do $$ begin
    create type trophy_tier as enum ('bronze', 'silver', 'gold', 'platinum');
exception
    when duplicate_object then null;
end $$;

do $$ begin
    create type tier_source as enum (
        'psn_native',           -- game has a PSN release; this is its real trophy tier
        'cross_platform_match', -- inherited from a matched PSN trophy on another platform's copy
        'rarity_fallback'       -- no PSN release exists; tier inferred from global unlock rarity
    );
exception
    when duplicate_object then null;
end $$;

create table if not exists canonical_achievements (
    id           uuid primary key default uuid_generate_v4(),
    game_id      uuid not null references games(id) on delete cascade,
    name         text not null,
    description  text,
    tier         trophy_tier not null,
    tier_source  tier_source not null,
    points       smallint not null,   -- resolved from tier via tier_points, denormalized for fast scoring
    icon_url     text,                -- set once from whichever platform's sync creates this row first, never overwritten
    created_at   timestamptz not null default now()
);

create table if not exists achievement_platform_links (
    id                      uuid primary key default uuid_generate_v4(),
    canonical_achievement_id uuid not null references canonical_achievements(id) on delete cascade,
    platform_id             text not null references platforms(id),
    -- Platform achievement IDs (e.g. Steam API names like "ACH_WIN_ONE_GAME")
    -- are only unique within one game, not globally, so uniqueness must be
    -- scoped by the platform's own game ID too.
    platform_game_id        text not null,
    platform_achievement_id text not null,
    platform_name           text not null,
    platform_description    text,
    global_unlock_rarity    numeric(5,2),   -- percent of players who have this; drives rarity_fallback tiering
    match_confidence        numeric(3,2),   -- 0-1, null when native or manually confirmed
    unique (platform_id, platform_game_id, platform_achievement_id)
);

-- Achievements a matching pass has proposed linking together, awaiting
-- confirmation before they're merged into one canonical_achievements row.
do $$ begin
    create type match_status as enum ('pending', 'confirmed', 'rejected');
exception
    when duplicate_object then null;
end $$;

create table if not exists achievement_match_candidates (
    id                          uuid primary key default uuid_generate_v4(),
    achievement_platform_link_id uuid not null references achievement_platform_links(id) on delete cascade,
    candidate_canonical_achievement_id uuid not null references canonical_achievements(id) on delete cascade,
    confidence                  numeric(3,2) not null,
    status                      match_status not null default 'pending',
    reviewed_at                 timestamptz
);

-- Whole-game merges a matching pass has proposed but won't perform
-- automatically, because the signal isn't strong enough to trust without a
-- human - either an exact-title match that involves RetroAchievements (a
-- classic-system title colliding with a modern remake/remaster sharing its
-- original's exact name), or a near-title match across platforms that isn't
-- exact at all (a short/colloquial title vs. the same game's full official
-- name). See #73, #76. game_a_id/game_b_id are always stored with
-- game_a_id < game_b_id (as text) so the unique constraint catches the same
-- pair regardless of which side gameMatcher happened to compare first.
create table if not exists game_merge_candidates (
    id              uuid primary key default uuid_generate_v4(),
    game_a_id       uuid not null references games(id) on delete cascade,
    game_b_id       uuid not null references games(id) on delete cascade,
    confidence      numeric(3,2) not null,
    reason          text not null,
    status          match_status not null default 'pending',
    reviewed_at     timestamptz,
    unique (game_a_id, game_b_id)
);

-- Games that already have a legacy-signal platform link (RetroAchievements,
-- or a PSN/Xbox link known to be an older-hardware-only release - see
-- isLegacyOnlyLink in gameMatcher.ts) merged in alongside a non-legacy
-- platform, the exact configuration current auto-merge rules refuse to
-- create going forward (#225, #227). These are almost always merges from
-- before that review-gate existed - a modern remake/remaster silently fused
-- with an older classic-system release of the same title (see #230, the
-- Resident Evil case) - since mergeGames deletes the losing game row, there
-- is no other record of when or how they were joined. Surfaced for a human
-- to split back apart (or dismiss as a genuine same-release match) via the
-- existing splitPlatformLink undo path, one legacy platform link at a time.
create table if not exists game_split_candidates (
    id                   uuid primary key default uuid_generate_v4(),
    game_id              uuid not null references games(id) on delete cascade,
    game_platform_link_id uuid not null references game_platform_links(id) on delete cascade,
    reason               text not null,
    status               match_status not null default 'pending',
    reviewed_at          timestamptz,
    unique (game_platform_link_id)
);

-- ---------------------------------------------------------------------------
-- Unlocks & scoring
-- ---------------------------------------------------------------------------

create table if not exists user_achievement_unlocks (
    id                          uuid primary key default uuid_generate_v4(),
    user_platform_account_id    uuid not null references user_platform_accounts(id) on delete cascade,
    achievement_platform_link_id uuid not null references achievement_platform_links(id) on delete cascade,
    unlocked_at                 timestamptz not null,
    unique (user_platform_account_id, achievement_platform_link_id)
);

-- When the app first saw an unlock, as opposed to when the platform says it
-- was earned (unlocked_at) - a first sync can import years-old unlocks. Lets
-- the desktop app notify about unlocks that are new to it (see #250). Rows
-- that predate the column get the migration time, which is before the
-- desktop app starts watching, so they never count as new.
alter table user_achievement_unlocks add column if not exists recorded_at timestamptz not null default now();
create index if not exists user_achievement_unlocks_recorded_at_idx on user_achievement_unlocks (recorded_at);

-- games/canonical_achievements are shared, deduplicated tables across every
-- user of the app (that's the point of the canonical model) - so "does this
-- user own this game" can't be inferred from a game merely existing in the
-- canonical tables for a platform they've linked. This records it explicitly,
-- populated during sync for every game the account has (achievements or not).
create table if not exists user_owned_games (
    id                       uuid primary key default uuid_generate_v4(),
    user_platform_account_id uuid not null references user_platform_accounts(id) on delete cascade,
    game_id                  uuid not null references games(id) on delete cascade,
    unique (user_platform_account_id, game_id)
);

-- See #58: a game merely missing from one sync's owned-games response isn't
-- safe to treat as removed immediately - a transient API hiccup or partial
-- response could wipe out real progress. Tracks how many consecutive syncs
-- in a row a previously-owned game has been absent; reconcileMissingOwnership
-- (canonicalStore.ts) only revokes/drops it once this crosses a threshold,
-- and any sync where the game is seen again resets/removes the row.
create table if not exists game_absence_streaks (
    user_platform_account_id  uuid not null references user_platform_accounts(id) on delete cascade,
    game_id                   uuid not null references games(id) on delete cascade,
    consecutive_missing_syncs smallint not null default 1,
    primary key (user_platform_account_id, game_id)
);

-- A per-user preference for hiding a game from their library view (see
-- #192). "hidden" removes it from the games list but it still counts
-- toward the user's score; "excluded" removes it from the list *and* its
-- points are subtracted from the user's score (see recomputeUserScore).
-- Per-user, like the overrides below - one user hiding a game must never
-- affect what a different user who owns the same shared game row sees.
create table if not exists user_game_visibility (
    user_id uuid not null references users(id) on delete cascade,
    game_id uuid not null references games(id) on delete cascade,
    mode    text not null check (mode in ('hidden', 'excluded')),
    primary key (user_id, game_id)
);

-- Lets a user paste their own cover art / achievement icon (see #32),
-- scoped to that user only - games/canonical_achievements are shared,
-- deduplicated rows across every user (see docs/data-model.md), so this is
-- deliberately its own per-user table rather than a column on those shared
-- rows: one user's paste must never change what a different user who owns
-- the same game/achievement sees.
create table if not exists user_game_cover_overrides (
    user_id         uuid not null references users(id) on delete cascade,
    game_id         uuid not null references games(id) on delete cascade,
    cover_image_url text not null,
    primary key (user_id, game_id)
);

create table if not exists user_achievement_icon_overrides (
    user_id                  uuid not null references users(id) on delete cascade,
    canonical_achievement_id uuid not null references canonical_achievements(id) on delete cascade,
    icon_url                 text not null,
    primary key (user_id, canonical_achievement_id)
);

-- Lets Steam sync skip re-fetching a game's achievement schema/unlocks/global
-- rarity when nothing about that game could have changed since last sync -
-- see #21. Steam-specific (keyed on appid, not a canonical game_id) since
-- this is purely a sync-performance cache, not shared account/library state.
create table if not exists steam_game_sync_state (
    user_platform_account_id uuid not null references user_platform_accounts(id) on delete cascade,
    appid                    integer not null,
    playtime_forever         integer not null,
    rtime_last_played        integer not null,
    primary key (user_platform_account_id, appid)
);

-- getGlobalAchievementPercentages is re-fetched per owned game on every full
-- sync, but global rarity shifts slowly - see #27. Shared across every user
-- of the app (unlike steam_game_sync_state above, which is per-account),
-- since one game's global percentages are the same for everyone who owns it.
create table if not exists steam_global_rarity_cache (
    appid       integer primary key,
    percentages jsonb not null,
    fetched_at  timestamptz not null default now()
);

-- Records that a canonical game has already had a Steam-catalog tier
-- enrichment attempt (matching/steamCatalogEnrichment.ts), so a game with no
-- real Steam release - or a fixed, one-time lookup miss - doesn't get
-- re-searched against Steam's store API on every single sync's automatic
-- matching pass forever. A Steam release's achievement list/global rarity
-- isn't something that appears later for a game that never had it, so this
-- is never expired or retried automatically.
create table if not exists steam_catalog_enrichment_attempts (
    game_id      uuid primary key references games(id) on delete cascade,
    attempted_at timestamptz not null default now()
);

-- Same purpose as steam_catalog_enrichment_attempts above, for
-- matching/xboxCatalogEnrichment.ts.
create table if not exists xbox_catalog_enrichment_attempts (
    game_id      uuid primary key references games(id) on delete cascade,
    attempted_at timestamptz not null default now()
);

-- Same purpose as steam_catalog_enrichment_attempts above, for
-- matching/retroCatalogEnrichment.ts.
create table if not exists retro_catalog_enrichment_attempts (
    game_id      uuid primary key references games(id) on delete cascade,
    attempted_at timestamptz not null default now()
);

-- Point value per tier. A table rather than a hardcoded constant so it can
-- be tuned without a migration; seeded with PSN's published values.
create table if not exists tier_points (
    tier    trophy_tier primary key,
    points  smallint not null
);

insert into tier_points (tier, points) values
    ('bronze', 15),
    ('silver', 30),
    ('gold', 90),
    ('platinum', 300)
on conflict (tier) do nothing;

-- Cumulative points required to reach each level, precomputed by the
-- scoring service from a tunable curve (see docs/data-model.md).
create table if not exists level_thresholds (
    level           integer primary key,
    points_required bigint not null
);

-- Cached, precomputed per-user totals. Recomputed whenever a new unlock
-- comes in rather than aggregated live on every profile view.
create table if not exists user_scores (
    user_id       uuid primary key references users(id) on delete cascade,
    total_points  bigint not null default 0,
    level         integer not null default 1,
    computed_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Seed platforms
-- ---------------------------------------------------------------------------

insert into platforms (id, name, has_native_tiers) values
    ('psn', 'PlayStation Network', true),
    ('steam', 'Steam', false),
    ('xbox', 'Xbox', false),
    ('retroachievements', 'RetroAchievements', false),
    ('gog', 'GOG', false)
on conflict (id) do nothing;

