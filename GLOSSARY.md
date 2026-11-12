# Unified Achievement Manager

One person's achievements from every gaming platform they use, merged into a single library where each real game and achievement appears once.

## Library

**Canonical game**:
The single library entry for one real-world game, however many platforms it appears on.
_Avoid_: merged game, master game

**Canonical achievement**:
The single library entry for one real-world achievement, shared by every platform's copy of it.
_Avoid_: master achievement

**Achievement list**:
One game's full set of achievements as one platform defines them. PSN calls this a trophy list, and RPCS3 shares PSN's.
_Avoid_: schema, trophy set

## Platforms and sync

**Platform**:
A source of achievements: Steam, Xbox, PSN, RetroAchievements, GOG or RPCS3.
_Avoid_: service, provider

**Linked account**:
The user's account on one platform, or for RPCS3 a folder on this computer, that the app reads achievements from.
_Avoid_: platform account, connection

**Platform adapter**:
What one platform supplies to sync: the games the linked account owns, and each owned game's achievement list.
_Avoid_: platform sync, handler

**Sync pipeline**:
The one process that turns what a platform adapter reports into library changes: unlocks, revocations, ownership and tiers.
_Avoid_: sync handler, per-platform sync

**Owned game**:
A game the platform reports the linked account owns during a sync, whether or not it has achievements.
_Avoid_: title, product, appid

**Change marker**:
A platform-supplied value for an owned game that only changes when its achievements might have; an unchanged marker means the game is skipped.
_Avoid_: sync state, skip-cache entry

**Revocation**:
Removing a recorded unlock because the platform now reports that achievement as locked.
_Avoid_: un-unlock, reset

**Reconciliation**:
Checking which previously owned games the platform no longer reports, and dropping their ownership after repeated absences.
_Avoid_: cleanup, pruning
