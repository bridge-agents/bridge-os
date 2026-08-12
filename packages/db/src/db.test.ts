import { newAgentId, newWorkspaceId } from "@bridge/core";
import { parseManifest, personalAssistantTemplate, SPEC_VERSION } from "@bridge/spec";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createDb } from "./client.js";
import { agents, workspaces } from "./schema.js";

/**
 * Integration test: requires a migrated database (DATABASE_URL). Runs in CI
 * against the postgres service; skipped locally when the env var is absent.
 */
const url = process.env.DATABASE_URL;

describe.skipIf(!url)("db round-trip", () => {
  const { db, close } = url ? createDb(url) : { db: undefined, close: async () => {} };

  afterAll(async () => {
    await close();
  });

  it("stores and returns a manifest that still validates", async () => {
    if (!db) throw new Error("unreachable");
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
