import { normalize } from "./normalize";

// Some platforms' lists for a collection put a per-game tag in front of
// every achievement name, and the same list elsewhere doesn't (see #357):
// Xbox has "FFX: Mega Strike" and "TR2 Crime and Punishment" where Steam has
// "Mega Strike" and "TR2 | Crime and Punishment". Stripping the tag lets the
// matcher compare what's left.

// A tag is a short all-caps first word ("TR", "TR3:LA", "FFX-2"), optionally
// followed by ":" or a separate "|".
const TAG_PATTERN = /^([A-Z0-9][A-Z0-9:\-.]{0,9}?)(?::|\s+\|)?\s+(\S.*)$/;
// How many of a list's names must start with the same tag for it to count,
// so a lone "DOOM Slayer" isn't read as tagged.
const MIN_TAG_USES = 3;
// Share of a list's names that must carry a tag for the list to be tagged.
const MIN_TAGGED_SHARE = 0.8;

function splitTag(name: string): { tag: string; rest: string } | null {
    const match = TAG_PATTERN.exec(name.trim());
    if (!match || !/[A-Z]/.test(match[1])) return null;
    return { tag: match[1], rest: match[2] };
}

// Each name with its list's tag removed, or unchanged when the list isn't
// tagged. `names` is one platform's list for one game.
export function stripListTags(names: string[]): string[] {
    const splits = names.map(splitTag);
    const uses = new Map<string, number>();
    for (const split of splits) if (split) uses.set(split.tag, (uses.get(split.tag) ?? 0) + 1);
    const isTag = (split: { tag: string } | null) => split !== null && (uses.get(split.tag) ?? 0) >= MIN_TAG_USES;
    const taggedCount = splits.filter(isTag).length;
    if (names.length === 0 || taggedCount / names.length < MIN_TAGGED_SHARE) return names;
    return names.map((name, i) => (isTag(splits[i]) ? splits[i]!.rest : name));
}

// Counts how many distinct achievements share each stripped name, so a match
// on the stripped name is only trusted when it's unambiguous: a collection's
// games can each have an achievement with the same name.
export function countStrippedNames(entries: { key: string; stripped: string }[]): Map<string, number> {
    const keysByName = new Map<string, Set<string>>();
    for (const { key, stripped } of entries) {
        const name = normalize(stripped);
        if (!keysByName.has(name)) keysByName.set(name, new Set());
        keysByName.get(name)!.add(key);
    }
    return new Map([...keysByName].map(([name, keys]) => [name, keys.size]));
}
