import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseSecretKey } from "./crypto.js";
import { keychainBackend, keychainDelete, keychainGet, keychainSet } from "./keychain.js";
import { forgetSecretKey, loadOrCreateSecretKey } from "./secret-key.js";

/**
 * The key that decrypts every stored provider credential.
 *
 * The bug these cover: a desktop Bridge used to generate a throwaway key at
 * boot, so restarting silently orphaned every API key the user had
 * connected. "The same key comes back" is the whole feature.
 */
let dir: string;
const ACCOUNT = "secret-key";
/**
 * These talk to the real credential store, so they get their own namespace.
 * Running the suite must never overwrite or delete the key protecting the
 * credentials of the Bridge actually installed on this machine.
 */
const NAMESPACE = `Bridge Test ${process.pid}`;
let previousNamespace: string | undefined;
let hasKeychain = false;

beforeAll(() => {
  previousNamespace = process.env.BRIDGE_KEYCHAIN_SERVICE;
  process.env.BRIDGE_KEYCHAIN_SERVICE = NAMESPACE;
});
afterAll(async () => {
  await keychainDelete(ACCOUNT);
  if (previousNamespace === undefined) delete process.env.BRIDGE_KEYCHAIN_SERVICE;
  else process.env.BRIDGE_KEYCHAIN_SERVICE = previousNamespace;
});

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "bridge-key-"));
  await keychainDelete(ACCOUNT);
  hasKeychain = keychainBackend() !== "unavailable" && (await canStore());
});
afterEach(async () => {
  await forgetSecretKey(dir);
  rmSync(dir, { recursive: true, force: true });
});

/** Present is not the same as usable: a headless Linux box has no session bus. */
async function canStore(): Promise<boolean> {
  const stored = await keychainSet(ACCOUNT, "probe");
  await keychainDelete(ACCOUNT);
  return stored;
}

describe("the master secret key", () => {
  it("uses the configured key and stores nothing", async () => {
    const configured = "dGVzdC1rZXktdGVzdC1rZXktdGVzdC1rZXktMTIzNA==";
    const source = await loadOrCreateSecretKey({
      dataDir: dir,
      env: { BRIDGE_SECRET_KEY: configured },
    });

    // A server's key belongs to its operator; Bridge must not copy it into
    // the credential store of whoever happened to start the process.
    expect(source).toEqual({ value: configured, storage: "env" });
  });

  it("generates a usable 32-byte key when there is none", async () => {
    const source = await loadOrCreateSecretKey({ dataDir: dir, env: {} });

    expect(() => parseSecretKey(source.value)).not.toThrow();
    expect(parseSecretKey(source.value)).toHaveLength(32);
  });

  it("returns the same key on the next boot", async () => {
    const first = await loadOrCreateSecretKey({ dataDir: dir, env: {} });
    const second = await loadOrCreateSecretKey({ dataDir: dir, env: {} });

    expect(second.value).toBe(first.value);
  });

  it("reports honestly where the key is kept", async () => {
    const source = await loadOrCreateSecretKey({ dataDir: dir, env: {} });

    // The UI tells the user which protection they actually have, so this
    // must never claim a keychain it did not write to.
    expect(source.storage).toBe(hasKeychain ? keychainBackend() : "file");
    expect(source.warning === undefined).toBe(hasKeychain);
  });

  it("keeps a fallback key file readable only by its owner", async () => {
    if (hasKeychain) return;
    await loadOrCreateSecretKey({ dataDir: dir, env: {} });

    const mode = statSync(join(dir, "secret.key")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("adopts a key an earlier boot left on disk", async () => {
    // Losing this would lose every credential encrypted with it, so an
    // existing file is adopted rather than replaced.
    const existing = "b2xkLWtleS1vbGQta2V5LW9sZC1rZXktb2xkLWtleTE=";
    writeFileSync(join(dir, "secret.key"), `${existing}\n`, { mode: 0o600 });

    const source = await loadOrCreateSecretKey({ dataDir: dir, env: {} });
    expect(source.value).toBe(existing);
  });

  it("moves an on-disk key into the credential store when there is one", async () => {
    if (!hasKeychain) return;
    const existing = "b2xkLWtleS1vbGQta2V5LW9sZC1rZXktb2xkLWtleTE=";
    writeFileSync(join(dir, "secret.key"), `${existing}\n`, { mode: 0o600 });

    const source = await loadOrCreateSecretKey({ dataDir: dir, env: {} });

    expect(source.storage).toBe(keychainBackend());
    expect(await keychainGet(ACCOUNT)).toBe(existing);
    // Only removed after the store read it back, because a lost key is
    // unrecoverable.
    expect(() => readFileSync(join(dir, "secret.key"))).toThrow();
  });
});
