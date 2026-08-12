import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { BridgeError } from "./errors.js";

/**
 * Password hashing, secret encryption and token hashing built on Node's
 * stdlib crypto. Deliberately no native dependency (argon2, libsodium): the
 * desktop app has to package this runtime for macOS, Windows and Linux, and
 * native modules are the usual reason that breaks (ADR-0011).
 *
 * scrypt parameters follow an OWASP-approved configuration (N=2^15, r=8,
 * p=3). Raise SCRYPT_N when hardware moves; the parameters are stored in
 * each hash so existing passwords keep verifying.
 */
const SCRYPT_N = 2 ** 15;
const SCRYPT_R = 8;
const SCRYPT_P = 3;
const SCRYPT_KEYLEN = 32;
const SCRYPT_MAXMEM = 128 * SCRYPT_N * SCRYPT_R * 2;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password.normalize("NFKC"), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64"),
    hash.toString("base64"),
  ].join("$");
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, n, r, p, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !n || !r || !p || !salt || !hash) return false;

  const expected = Buffer.from(hash, "base64");
  const actual = scryptSync(
    password.normalize("NFKC"),
    Buffer.from(salt, "base64"),
    expected.length,
    {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 128 * Number(n) * Number(r) * 2,
    },
  );
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** 32-byte key from a base64 string, as supplied by BRIDGE_SECRET_KEY. */
export function parseSecretKey(value: string): Buffer {
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw new BridgeError(
      "internal",
      "BRIDGE_SECRET_KEY must be 32 bytes encoded as base64 (generate one with `openssl rand -base64 32`)",
    );
  }
  return key;
}

export function generateSecretKey(): string {
  return randomBytes(32).toString("base64");
}

/** AES-256-GCM. Output is self-describing: v1.<iv>.<authTag>.<ciphertext>. */
export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    "v1",
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    ciphertext.toString("base64"),
  ].join(".");
}

export function decryptSecret(encoded: string, key: Buffer): string {
  const [version, iv, tag, ciphertext] = encoded.split(".");
  if (version !== "v1" || !iv || !tag || !ciphertext) {
    throw new BridgeError("internal", "malformed encrypted secret");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  // Throws if the ciphertext or key was tampered with — never returns garbage.
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** Opaque session/API token. The raw value is shown once; only its hash is stored. */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64");
}

/** Show enough of a credential to recognise it, never enough to use it. */
export function maskSecret(value: string): string {
  return value.length <= 8 ? "…" : `${value.slice(0, 3)}…${value.slice(-4)}`;
}
