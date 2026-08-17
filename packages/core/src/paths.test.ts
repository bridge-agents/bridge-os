import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { apiAddressFile, appConfigDir, appDataDir, embeddedDatabaseUrl } from "./paths.js";

/**
 * These decide where a user's agents, conversations and credentials live, so
 * the property under test is not the exact string — it is that an installed
 * app never writes beside its own code, and that an override is obeyed.
 */
describe("application paths", () => {
  it("puts data somewhere durable in the user's home", () => {
    const dir = appDataDir({});

    expect(dir.startsWith(homedir())).toBe(true);
    // Repo-relative would be lost on update and unwritable inside a signed
    // macOS bundle.
    expect(dir.startsWith(".")).toBe(false);
  });

  it("follows the platform's own convention", () => {
    const dir = appDataDir({});

    if (process.platform === "darwin") expect(dir).toContain("Library/Application Support");
    if (process.platform === "linux") expect(dir).toContain(".local/share");
  });

  it("obeys an explicit data directory", () => {
    expect(appDataDir({ BRIDGE_DATA_DIR: "/srv/bridge" })).toBe("/srv/bridge");
    expect(appConfigDir({ BRIDGE_CONFIG_DIR: "/etc/bridge" })).toBe("/etc/bridge");
  });

  it("respects XDG on Linux", () => {
    if (process.platform !== "linux") return;
    expect(appDataDir({ XDG_DATA_HOME: "/xdg/data" })).toBe("/xdg/data/bridge");
    expect(appConfigDir({ XDG_CONFIG_HOME: "/xdg/config" })).toBe("/xdg/config/bridge");
  });

  it("derives one database location from one data directory", () => {
    // Two processes disagreeing about this is a silently empty Bridge.
    expect(embeddedDatabaseUrl("/srv/bridge")).toBe("pglite:/srv/bridge/data");
    expect(apiAddressFile("/srv/bridge")).toBe("/srv/bridge/api.url");
  });
});
