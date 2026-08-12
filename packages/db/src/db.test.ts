import { newAgentId, newWorkspaceId } from "@bridge/core";
import { parseManifest, personalAssistantTemplate, SPEC_VERSION } from "@bridge/spec";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "./client.js";
import { agents, workspaces } from "./schema.js";

/**
 * Runs against embedded Postgres by default — no Docker, no services, so the
 * same suite covers the desktop runtime. Point DATABASE_URL at a server to
 * exercise the postgres-js driver instead.
 */
const url = process.env.DATABASE_URL ?? "pglite:memory";

describe(`db round-trip (${url.split(":")[0]})`, () => {
  let handle: DbHandle;

  beforeAll(async () => {
    handle = await createDb(url);
    await handle.migrate();
  }, 60_000);

  afterAll(async () => {
    await handle?.close();
  });

  it("stores and returns a manifest that still validates", async () => {
    const { db } = handle;
    const workspaceId = newWorkspaceId();
    const agentId = newAgentId();
    const manifest = personalAssistantTemplate.manifest;

    await db.insert(workspaces).values({ id: workspaceId, name: "Test Workspace" });
    await db.insert(agents).values({
      id: agentId,
      workspaceId,
      name: manifest.meta.name,
      slug: manifest.meta.slug,
      specVersion: SPEC_VERSION,
      manifest,
    });

    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(row).toBeDefined();
    // jsonb round-trip must survive spec validation — the DB never becomes a second schema authority
    expect(parseManifest(row?.manifest)).toEqual(manifest);

    await db.delete(workspaces).where(eq(workspaces.id, workspaceId)); // cascades to agents
    const remaining = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(remaining).toHaveLength(0);
  });
});
