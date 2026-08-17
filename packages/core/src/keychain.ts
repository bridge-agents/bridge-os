/**
 * The platform credential store, reached through the tools every OS already
 * ships — `security` on macOS, `secret-tool` on Linux, DPAPI via PowerShell
 * on Windows.
 *
 * Subprocesses rather than a native module on purpose (ADR-0011): a native
 * keychain binding would have to compile per OS *and* per Node ABI, which is
 * exactly the dependency that makes three-platform desktop packaging
 * miserable. The cost is a process spawn, which is fine for something read
 * once at boot and written when a user connects a provider.
 *
 * Everything here is best-effort by design. A machine with no keychain (a
 * headless Linux box with no libsecret, a locked-down container) gets
 * `undefined`/`false` and the caller falls back — Bridge must still start.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Namespace for stored items. Overridable so a test — or a second install on
 * the same machine — never writes over the key protecting someone's real
 * credentials.
 */
const service = () => process.env.BRIDGE_KEYCHAIN_SERVICE ?? "Bridge";

/** How the value is actually protected, for honest reporting in the UI. */
export type KeychainBackend = "macos-keychain" | "libsecret" | "windows-dpapi" | "unavailable";

/** A short timeout: a hung credential prompt must not hang the whole boot. */
const TIMEOUT_MS = 10_000;

export function keychainBackend(): KeychainBackend {
  switch (process.platform) {
    case "darwin":
      return "macos-keychain";
    case "win32":
      return "windows-dpapi";
    case "linux":
      return "libsecret";
    default:
      return "unavailable";
  }
}

/**
 * Windows has no built-in command that reads a password back out of
 * Credential Manager, so we use the other OS facility: DPAPI, which encrypts
 * with a key derived from the logged-in user account and held by the OS. The
 * ciphertext is useless to another user or another machine, which is the
 * property we actually want. The caller stores the returned blob.
 */
async function dpapi(direction: "protect" | "unprotect", input: string): Promise<string> {
  const script =
    direction === "protect"
      ? "$p=[Console]::In.ReadToEnd(); ConvertTo-SecureString -String $p -AsPlainText -Force | ConvertFrom-SecureString"
      : "$b=[Console]::In.ReadToEnd().Trim(); " +
        "$s=ConvertTo-SecureString -String $b; " +
        "[Runtime.InteropServices.Marshal]::PtrToStringAuto(" +
        "[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))";

  const child = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    timeout: TIMEOUT_MS,
  });
  // The value goes over stdin, never argv: command lines are readable by
  // other processes on the machine.
  child.child.stdin?.end(input);
  const { stdout } = await child;
  return stdout.trim();
}

/**
 * Read a stored value. Returns undefined when there is nothing stored *or*
 * when the platform has no credential store — the caller cannot tell the
 * difference and should not need to.
 */
export async function keychainGet(account: string): Promise<string | undefined> {
  try {
    if (process.platform === "darwin") {
      const { stdout } = await run(
        "security",
        ["find-generic-password", "-s", service(), "-a", account, "-w"],
        { timeout: TIMEOUT_MS },
      );
      return stdout.trim() || undefined;
    }
    if (process.platform === "linux") {
      const { stdout } = await run(
        "secret-tool",
        ["lookup", "service", service(), "account", account],
        {
          timeout: TIMEOUT_MS,
        },
      );
      return stdout.trim() || undefined;
    }
    if (process.platform === "win32") {
      const { stdout } = await run(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-ItemProperty -Path 'HKCU:\\Software\\${service()}' -Name '${account}' -ErrorAction Stop).'${account}'`,
        ],
        { timeout: TIMEOUT_MS },
      );
      const blob = stdout.trim();
      return blob ? await dpapi("unprotect", blob) : undefined;
    }
  } catch {
    // Not found, no credential tool, locked keychain, no session bus — all
    // mean the same thing here: we have nothing.
  }
  return undefined;
}

/** Store a value, replacing any existing one. False when the OS cannot. */
export async function keychainSet(account: string, value: string): Promise<boolean> {
  try {
    if (process.platform === "darwin") {
      // -U updates in place; without it a second write fails as a duplicate.
      // ponytail: the value is passed on argv because `security` has no stdin
      // form. Same-user processes can see it, but a same-user process can
      // just ask the keychain itself, so this exposes nothing new.
      await run(
        "security",
        ["add-generic-password", "-s", service(), "-a", account, "-w", value, "-U"],
        { timeout: TIMEOUT_MS },
      );
      return true;
    }
    if (process.platform === "linux") {
      const child = run(
        "secret-tool",
        ["store", "--label", `${service()} (${account})`, "service", service(), "account", account],
        { timeout: TIMEOUT_MS },
      );
      child.child.stdin?.end(value);
      await child;
      return true;
    }
    if (process.platform === "win32") {
      const blob = await dpapi("protect", value);
      const child = run(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `New-Item -Path 'HKCU:\\Software\\${service()}' -Force | Out-Null; ` +
            `Set-ItemProperty -Path 'HKCU:\\Software\\${service()}' -Name '${account}' -Value ([Console]::In.ReadToEnd().Trim())`,
        ],
        { timeout: TIMEOUT_MS },
      );
      // Only the DPAPI blob crosses this boundary; the plaintext never does.
      child.child.stdin?.end(blob);
      await child;
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

/** Remove a stored value. Succeeds when there was nothing to remove. */
export async function keychainDelete(account: string): Promise<void> {
  try {
    if (process.platform === "darwin") {
      await run("security", ["delete-generic-password", "-s", service(), "-a", account], {
        timeout: TIMEOUT_MS,
      });
    } else if (process.platform === "linux") {
      await run("secret-tool", ["clear", "service", service(), "account", account], {
        timeout: TIMEOUT_MS,
      });
    } else if (process.platform === "win32") {
      await run(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Remove-ItemProperty -Path 'HKCU:\\Software\\${service()}' -Name '${account}' -ErrorAction SilentlyContinue`,
        ],
        { timeout: TIMEOUT_MS },
      );
    }
  } catch {
    // Already gone, or nothing to talk to.
  }
}
