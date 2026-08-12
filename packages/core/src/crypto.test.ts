import { describe, expect, it } from "vitest";
import {
  decryptSecret,
  encryptSecret,
  generateSecretKey,
  generateToken,
  hashPassword,
  hashToken,
  maskSecret,
  parseSecretKey,
  verifyPassword,
} from "./crypto.js";

const key = parseSecretKey(generateSecretKey());

describe("passwords", () => {
  it("verifies the correct password and rejects wrong ones", () => {
    const stored = hashPassword("correct horse battery staple");
    expect(verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(verifyPassword("Correct horse battery staple", stored)).toBe(false);
    expect(verifyPassword("", stored)).toBe(false);
  });

  it("never stores the password itself and salts each hash", () => {
    const password = "hunter2-hunter2";
    const a = hashPassword(password);
    const b = hashPassword(password);
    expect(a).not.toContain(password);
    expect(a).not.toBe(b);
    expect(verifyPassword(password, b)).toBe(true);
  });

  it("rejects malformed stored hashes instead of throwing", () => {
    expect(verifyPassword("x", "")).toBe(false);
    expect(verifyPassword("x", "argon2$whatever")).toBe(false);
    expect(verifyPassword("x", "scrypt$1$2")).toBe(false);
  });
});

describe("secret encryption", () => {
  it("round-trips", () => {
    const apiKey = "sk-ant-api03-not-a-real-key";
    const encrypted = encryptSecret(apiKey, key);
    expect(encrypted).not.toContain(apiKey);
    expect(decryptSecret(encrypted, key)).toBe(apiKey);
  });

  it("produces a different ciphertext each time (random iv)", () => {
    expect(encryptSecret("same", key)).not.toBe(encryptSecret("same", key));
  });

  it("refuses to decrypt with the wrong key", () => {
    const encrypted = encryptSecret("secret", key);
    expect(() => decryptSecret(encrypted, parseSecretKey(generateSecretKey()))).toThrow();
  });

  it("refuses tampered ciphertext rather than returning garbage", () => {
    const [v, iv, tag, data] = encryptSecret("secret", key).split(".");
    const flipped = Buffer.from(data ?? "", "base64");
    if (flipped[0] !== undefined) flipped[0] ^= 0xff;
    expect(() => decryptSecret([v, iv, tag, flipped.toString("base64")].join("."), key)).toThrow();
  });

  it("rejects keys that are not 32 bytes", () => {
    expect(() => parseSecretKey(Buffer.from("short").toString("base64"))).toThrow(/32 bytes/);
  });
});

describe("tokens", () => {
  it("hashes are stable, one-way and unique per token", () => {
    const token = generateToken();
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toContain(token);
    expect(hashToken(generateToken())).not.toBe(hashToken(token));
  });
});

describe("maskSecret", () => {
  it("shows a recognisable prefix and suffix only", () => {
    expect(maskSecret("sk-ant-api03-abcdefghijkl")).toBe("sk-…ijkl");
    expect(maskSecret("short")).toBe("…");
  });
});
