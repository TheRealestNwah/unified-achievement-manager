import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const VERSION_PREFIX = "enc:v1:";

export function parseCredentialEncryptionKey(value: string): Buffer {
    let key: Buffer;
    try {
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) throw new Error();
        key = Buffer.from(value, "base64");
    } catch {
        throw new Error("The credential encryption key in secrets.json must be a base64-encoded 32-byte key");
    }
    if (key.length !== KEY_BYTES) {
        throw new Error("The credential encryption key in secrets.json must be a base64-encoded 32-byte key");
    }
    return key;
}

export function isEncryptedCredential(value: string): boolean {
    return value.startsWith(VERSION_PREFIX);
}

export function encryptCredential(value: string, key: Buffer): string {
    if (!value) throw new Error("Cannot encrypt an empty credential");
    if (key.length !== KEY_BYTES) throw new Error("Credential encryption key must be 32 bytes");

    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${VERSION_PREFIX}${iv.toString("base64")}:${authTag.toString("base64")}:${ciphertext.toString("base64")}`;
}

export function decryptCredential(value: string, key: Buffer): string {
    if (!isEncryptedCredential(value)) return value;
    if (key.length !== KEY_BYTES) throw new Error("Credential encryption key must be 32 bytes");

    const encoded = value.slice(VERSION_PREFIX.length).split(":");
    if (encoded.length !== 3) throw new Error("Malformed encrypted credential");

    try {
        const [iv, authTag, ciphertext] = encoded.map((part) => Buffer.from(part, "base64"));
        if (iv.length !== IV_BYTES || authTag.length !== 16 || ciphertext.length === 0) {
            throw new Error("Malformed encrypted credential");
        }
        const decipher = createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(authTag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch {
        throw new Error("Unable to decrypt credential");
    }
}
