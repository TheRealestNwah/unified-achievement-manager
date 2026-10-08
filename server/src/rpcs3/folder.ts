import fs from "fs";
import path from "path";
import { COMMUNICATION_ID } from "./trophyFiles";

// Finding RPCS3's per-user folders (see #522). The user picks the RPCS3
// folder (dev_hdd0 sits next to rpcs3.exe) or, when they've moved it in
// RPCS3's settings, the dev_hdd0 folder itself.

export interface Rpcs3User {
    id: string;
    name: string;
    games: number;
}

export class Rpcs3FolderError extends Error {}

// RPCS3 user IDs are eight digits: 00000001, 00000002, ...
const USER_ID = /^\d{8}$/;

function isDirectory(p: string): boolean {
    try {
        return fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
}

// The dev_hdd0/home folder for a picked folder, or an error that says what
// was expected.
export function resolveHomeDir(folder: string): string {
    if (!folder.trim() || !path.isAbsolute(folder)) {
        throw new Rpcs3FolderError("Enter the full path to your RPCS3 folder.");
    }
    for (const home of [path.join(folder, "dev_hdd0", "home"), path.join(folder, "home")]) {
        if (isDirectory(home)) return home;
    }
    throw new Rpcs3FolderError("That folder doesn't look like RPCS3's: there's no dev_hdd0 folder in it. Pick the folder rpcs3.exe is in.");
}

export function trophyDir(folder: string, userId: string): string {
    if (!USER_ID.test(userId)) throw new Rpcs3FolderError("That isn't an RPCS3 user.");
    return path.join(resolveHomeDir(folder), userId, "trophy");
}

// The game folders (one per NP communication ID) a user has trophies in.
export function listTrophyFolders(folder: string, userId: string): string[] {
    const dir = trophyDir(folder, userId);
    if (!isDirectory(dir)) return [];
    return fs
        .readdirSync(dir)
        .filter((name) => COMMUNICATION_ID.test(name) && isDirectory(path.join(dir, name)))
        .sort()
        .map((name) => path.join(dir, name));
}

export function listUsers(folder: string): Rpcs3User[] {
    const home = resolveHomeDir(folder);
    return fs
        .readdirSync(home)
        .filter((id) => USER_ID.test(id) && isDirectory(path.join(home, id)))
        .sort()
        .map((id) => {
            let name = id;
            try {
                name = fs.readFileSync(path.join(home, id, "localusername"), "utf8").trim() || id;
            } catch {
                // No name saved - the ID is what RPCS3 shows then too.
            }
            return { id, name, games: listTrophyFolders(folder, id).length };
        });
}
