import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listTrophyFolders, listUsers, Rpcs3FolderError, trophyDir } from "./folder";

let root: string;

function mkdir(...parts: string[]): string {
    const dir = path.join(root, ...parts);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "uam-rpcs3-folder-"));
});

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

describe("RPCS3 folders", () => {
    it("lists users with their names and game counts", () => {
        const user = mkdir("dev_hdd0", "home", "00000001");
        fs.writeFileSync(path.join(user, "localusername"), "Player One\n");
        mkdir("dev_hdd0", "home", "00000001", "trophy", "NPWR00001_00");
        mkdir("dev_hdd0", "home", "00000001", "trophy", "NPWR00002_00");
        mkdir("dev_hdd0", "home", "00000001", "trophy", "not-a-game");
        mkdir("dev_hdd0", "home", "00000002");
        mkdir("dev_hdd0", "home", "notauser");

        expect(listUsers(root)).toEqual([
            { id: "00000001", name: "Player One", games: 2 },
            { id: "00000002", name: "00000002", games: 0 },
        ]);
        expect(listTrophyFolders(root, "00000001").map((f) => path.basename(f))).toEqual(["NPWR00001_00", "NPWR00002_00"]);
    });

    it("accepts the dev_hdd0 folder itself", () => {
        mkdir("dev_hdd0", "home", "00000001");
        expect(listUsers(path.join(root, "dev_hdd0")).map((u) => u.id)).toEqual(["00000001"]);
    });

    it("explains a folder that isn't RPCS3's", () => {
        expect(() => listUsers(root)).toThrow(Rpcs3FolderError);
        expect(() => listUsers("relative/path")).toThrow(/full path/);
    });

    it("refuses user IDs that could leave the home folder", () => {
        mkdir("dev_hdd0", "home", "00000001");
        expect(() => trophyDir(root, "../..")).toThrow(Rpcs3FolderError);
    });
});
