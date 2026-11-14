import { AchievementEntry } from "./platformAdapter";

// The fields the GOG, RetroAchievements and Xbox clients' achievements share.
export interface ClientAchievement {
    id: string;
    name: string;
    description?: string;
    iconUrl?: string;
    isUnlocked: boolean;
}

// Turns a client's achievement into the pipeline's entry. Each platform
// reports rarity and unlock time its own way, so the caller passes those in.
// A locked achievement never has an unlock time.
export function toAchievementEntry(
    achievement: ClientAchievement,
    platformFields: { rarity?: number; unlockedAt: Date | null },
): AchievementEntry {
    return {
        id: achievement.id,
        name: achievement.name,
        description: achievement.description,
        rarity: platformFields.rarity,
        iconUrl: achievement.iconUrl,
        unlocked: achievement.isUnlocked,
        unlockedAt: achievement.isUnlocked ? platformFields.unlockedAt : null,
    };
}
