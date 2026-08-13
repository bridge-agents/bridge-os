import { describe, expect, it } from "vitest";
import { ApiClient, CliError } from "./client.js";

const unreachable = (async () => {
  throw new TypeError("fetch failed");
}) as unknown as typeof fetch;

describe("ApiClient", () => {
  it("turns a refused connection into an actionable error, not a bare TypeError", async () => {
    const client = new ApiClient({ apiUrl: "http://localhost:4000", fetchImpl: unreachable });

    await expect(client.get("/v1/auth/me")).rejects.toThrow(CliError);
    await expect(client.get("/v1/auth/me")).rejects.toThrow(
      /Can't reach Bridge at http:\/\/localhost:4000/,
    );
    await expect(client.get("/v1/auth/me")).rejects.toThrow(/pnpm dev/);
  });

  it("does the same for a streamed request", async () => {
    const client = new ApiClient({ apiUrl: "http://localhost:4000", fetchImpl: unreachable });
    const drain = async () => {
      for await (const _event of client.stream("/v1/workspaces/w/runs/r/stream")) {
        // never reached
      }
    };
    await expect(drain()).rejects.toThrow(/Can't reach Bridge/);
  });
});
