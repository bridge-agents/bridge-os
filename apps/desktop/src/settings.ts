import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The handful of choices that belong to this device rather than to the
 * workspace — so they live in a file next to the data, not in the database
 * that an agent's manifest could travel away from.
 */
export interface DesktopSettings {
  /**
   * Whether closing the window leaves agents running. Off by default: an app
   * that keeps working after you close it has to be something you chose,
   * not something you discover.
   */
  runInBackground: boolean;
  /** Notify when an agent is waiting for a decision. */
  notifyOnApproval: boolean;
}

const DEFAULTS: DesktopSettings = { runInBackground: false, notifyOnApproval: true };

export function loadSettings(dataDir: string): DesktopSettings {
  try {
    const raw = JSON.parse(readFileSync(file(dataDir), "utf8")) as Partial<DesktopSettings>;
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(dataDir: string, settings: DesktopSettings): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file(dataDir), `${JSON.stringify(settings, null, 2)}\n`);
}

const file = (dataDir: string) => join(dataDir, "desktop.json");
