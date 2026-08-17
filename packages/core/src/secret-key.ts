import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateSecretKey } from "./crypto.js";
import { keychainBackend, keychainDelete, keychainGet, keychainSet } from "./keychain.js";

/**
 * The key that encrypts every stored credential.
 *
 * On a server this is `BRIDGE_SECRET_KEY` and an operator owns it. On a
 * desktop there is no operator, and until now the local API generated an
 * ephemeral key at boot — which means every restart silently orphaned the
 * provider keys the user had connected. That is the bug this closes.
 *
 * The key lives in the OS credential store, and the credentials themselves
 * stay as AES-256-GCM rows in the database. One keychain item rather than one
 * per secret: the protection is the same (both defeat someone reading the
 * application-data directory), it costs one credential-store round trip at
 * boot instead of one per credential on every agent run, and the runtime's
 * `SecretStore` does not change shape. If per-item keychain ACLs ever earn
 * their keep, this is the seam to change.
 */
const KEY_ACCOUNT = "secret-key";
const KEY_FILE = "secret.key";

/** Where the key came from, so the app can tell the user the truth. */
export type KeyStorage = "env" | "macos-keychain" | "libsecret" | "windows-dpapi" | "file";

export interface SecretKeySource {
  /** base64, 32 bytes — the form `parseSecretKey` expects. */
  value: string;
  storage: KeyStorage;
  /** Set when we had to fall back to a file, so the caller can warn once. */
  warning?: string;
}

/**
 * Find the key, or make one and remember it. Idempotent: the second boot on a
 * machine returns exactly what the first one stored.
 */
export async function loadOrCreateSecretKey(options: {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
}): Promise<SecretKeySource> {
  const env = options.env ?? process.env;
  if (env.BRIDGE_SECRET_KEY) return { value: env.BRIDGE_SECRET_KEY, storage: "env" };

  const backend = keychainBackend();
  const file = join(options.dataDir, KEY_FILE);

  const stored = await keychainGet(KEY_ACCOUNT);
  if (stored) return { value: stored, storage: backend as KeyStorage };

  // A key written by an earlier boot that had no credential store. Move it in
  // if we can now, so a machine that gains libsecret stops keeping a key on
  // disk — but only remove the file once the keychain reads it back, because
  // losing this key means losing every stored credential.
  const onDisk = await readFile(file, "utf8").catch(() => undefined);
  if (onDisk?.trim()) {
    const value = onDisk.trim();
    if (await promote(value)) {
      await unlink(file).catch(() => undefined);
      return { value, storage: backend as KeyStorage };
    }
    return { value, storage: "file", warning: fileWarning(file) };
  }

  const value = generateSecretKey();
  if (await promote(value)) return { value, storage: backend as KeyStorage };

  await mkdir(options.dataDir, { recursive: true });
  // 0600 is the best available when there is no credential store. It stops
  // other users on the machine, not someone with your login.
  await writeFile(file, `${value}\n`, { mode: 0o600 });
  return { value, storage: "file", warning: fileWarning(file) };
}

/** Write to the credential store and confirm it can be read back. */
async function promote(value: string): Promise<boolean> {
  if (!(await keychainSet(KEY_ACCOUNT, value))) return false;
  return (await keychainGet(KEY_ACCOUNT)) === value;
}

/** Replace Bridge's persisted, application-owned master key. */
export async function persistSecretKey(
  dataDir: string,
  value: string,
): Promise<{ storage: Exclude<KeyStorage, "env">; warning?: string }> {
  const backend = keychainBackend();
  const file = join(dataDir, KEY_FILE);
  if (await promote(value)) {
    await unlink(file).catch(() => undefined);
    return { storage: backend as Exclude<KeyStorage, "env"> };
  }
  await mkdir(dataDir, { recursive: true });
  await writeFile(file, `${value}\n`, { mode: 0o600 });
  return { storage: "file", warning: fileWarning(file) };
}

function fileWarning(file: string): string {
  return `no OS credential store available — the key protecting your saved provider keys is in ${file} (owner-only)`;
}

/** Forget the stored key. Used by "reset Bridge" in the desktop app. */
export async function forgetSecretKey(dataDir: string): Promise<void> {
  await keychainDelete(KEY_ACCOUNT);
  await unlink(join(dataDir, KEY_FILE)).catch(() => undefined);
}
