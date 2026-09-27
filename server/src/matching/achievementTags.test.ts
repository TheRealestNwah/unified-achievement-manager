import { describe, expect, it } from "vitest";
import { countStrippedNames, stripListTags } from "./achievementTags";

describe("stripListTags (#357)", () => {
    it("strips Xbox's bare and colon tags", () => {
        expect(stripListTags(["TR Codex of Peru", "TR2 The Dissolution", "TR Feast Your Eyes on This!", "TR2 Crime and Punishment", "TR Look Over Us", "TR2 Extinct"])).toEqual([
            "Codex of Peru",
            "The Dissolution",
            "Feast Your Eyes on This!",
            "Crime and Punishment",
            "Look Over Us",
            "Extinct",
        ]);
        expect(stripListTags(["FFX: Mega Strike", "FFX-2: Sphere Hunter", "FFX: All Together", "FFX-2: Teamwork!", "FFX: Learning!", "FFX-2: Just Starting"])).toEqual([
            "Mega Strike",
            "Sphere Hunter",
            "All Together",
            "Teamwork!",
            "Learning!",
            "Just Starting",
        ]);
    });

    it("strips Steam's pipe tags, including ones with a colon inside", () => {
        expect(stripListTags(["TR1 | Codex of Peru", "TR3:LA | Heaven Express", "TR1 | Pain in Your Brain!", "TR3:LA | Another Mystery Solved", "TR1 | Dionysius’ Wisdom", "TR3:LA | Last One"])).toEqual([
            "Codex of Peru",
            "Heaven Express",
            "Pain in Your Brain!",
            "Another Mystery Solved",
            "Dionysius’ Wisdom",
            "Last One",
        ]);
    });

    it("leaves an untagged list alone, even with a few all-caps first words", () => {
        const names = ["DOOM Slayer", "A Moral Victory", "A True Ruler", "A Pirate's Life", "Overkill", "Chocobo License", "The Right Thing", "Learner"];
        expect(stripListTags(names)).toEqual(names);
    });
});

describe("countStrippedNames", () => {
    it("counts distinct achievements per normalized stripped name", () => {
        const counts = countStrippedNames([
            { key: "a", stripped: "Sphere Hunter" },
            { key: "a", stripped: "Sphere Hunter" }, // same achievement on a second platform
            { key: "b", stripped: "sphere hunter!" },
            { key: "c", stripped: "Mega Strike" },
        ]);
        expect(counts.get("sphere hunter")).toBe(2);
        expect(counts.get("mega strike")).toBe(1);
    });
});
