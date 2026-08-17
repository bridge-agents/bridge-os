import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where Bridge keeps its data on a user's machine.
 *
 * Repo-relative paths (`./.bridge`) are right for `pnpm dev` and wrong for an
 * installed app: an installed app's working directory is wherever the OS
 * launched it from, and on macOS the bundle itself is read-only. So the
 * desktop build resolves these once, at boot, and everything downstream —
 * the embedded database, agent workspaces, uploads, CLI config — hangs off
 * the result.
 *
 * These are the conventional locations per platform, so backup software,
 * "reset the app", and uninstallers all find what they expect.
 */
const APP = "Bridge";

/** Durable application data: the database, agent workspaces, uploads. */
export function appDataDir(env: NodeJS.ProcessEnv = process.env): string {
  // An explicit override wins everywhere — servers, CI, and anyone running
  // more than one Bridge on a machine.
  if (env.BRIDGE_DATA_DIR) return env.BRIDGE_DATA_DIR;

  switch (process.platform) {
    case "darwin":
      return join(homedir(), "Library", "Application Support", APP);
    case "win32":
      return join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), APP);
    default:
      // XDG: data (not config) — this is state the user cannot hand-edit.
      return join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "bridge");
  }
}

/**
 * User configuration: which Bridge to talk to, and the CLI's token.
 *
 * Separate from data because it is small, hand-editable, and worth keeping
 * when someone deletes their local database.
 */
export function appConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.BRIDGE_CONFIG_DIR) return env.BRIDGE_CONFIG_DIR;

  switch (process.platform) {
    case "darwin":
      return join(homedir(), "Library", "Application Support", APP);
    case "win32":
      return join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), APP);
    default:
      return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "bridge");
  }
}

/**
 * The embedded database URL for a data directory.
 *
 * One place builds this string so the desktop app, the CLI and the API can
 * never disagree about which file the database lives in — two processes
 * opening two different PGlite directories is a silently empty Bridge.
 */
export function embeddedDatabaseUrl(dataDir: string): string {
  return `pglite:${join(dataDir, "data")}`;
}

/**
 * Where a running API publishes its address.
 *
 * An installed Bridge asks the OS for a free port rather than assuming 4000
 * is available, so the port is not knowable in advance. Writing it down is
 * how the desktop supervisor and a terminal `bridge` find the instance that
 * is actually running instead of guessing and failing to connect.
 */
export function apiAddressFile(dataDir: string): string {
  return join(dataDir, "api.url");
}
