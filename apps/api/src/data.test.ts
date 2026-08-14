import type { SourceData } from "@bridge/spec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { as, createTestApp, signUp, type TestApp, type TestUser } from "./testing.js";

let ctx: TestApp;
let user: TestUser;
let api: ReturnType<typeof as>;
let agentId: string;

/** Create a run directly, so aggregates have something deterministic to sum. */
async function seedRun(over: Record<string, unknown> = {}) {
  const { runs } = await import("@bridge/db");
  const id = `run_${Math.random().toString(16).slice(2, 12)}`;
  await ctx.handle.db.insert(runs).values({
    id,
    workspaceId: user.workspaceId,
    agentId,
    status: "succeeded",
    inputTokens: 100,
    outputTokens: 50,
    costUsd: "0.2500",
    ...over,
  });
  return id;
}

const read = async (source: string) => {
  const res = await api(`/v1/workspaces/${user.workspaceId}/data/${source}`);
  return { status: res.status, data: ((await res.json()) as { data: SourceData }).data };
};

beforeEach(async () => {
  ctx = await createTestApp();
  user = await signUp(ctx.app, "owner@example.com");
  api = as(ctx.app, user);

  const created = (await (
    await api(`/v1/workspaces/${user.workspaceId}/agents`, {
      method: "POST",
      body: JSON.stringify({ name: "Helper", instructions: "Help." }),
    })
  ).json()) as { agent: { id: string } };
  agentId = created.agent.id;
});
afterEach(async () => {
  await ctx.close();
});

describe("metric sources", () => {
  it("counts and sums runs in this workspace", async () => {
    await seedRun();
    await seedRun();

    expect((await read("runs.total")).data).toEqual({ kind: "metric", value: 2 });
    expect((await read("runs.cost.total")).data).toEqual({
      kind: "metric",
      unit: "usd",
      value: 0.5,
    });
    expect((await read("runs.tokens.total")).data).toEqual({
      kind: "metric",
      unit: "tokens",
      value: 300,
    });
  });

  it("counts only runs that are still going for the active metric", async () => {
    await seedRun({ status: "succeeded" });
    await seedRun({ status: "running" });
    await seedRun({ status: "queued" });

    expect((await read("runs.active")).data).toEqual({ kind: "metric", value: 2 });
  });

  it("returns zero rather than nothing when there is no data", async () => {
    expect((await read("runs.total")).data).toEqual({ kind: "metric", value: 0 });
    expect((await read("runs.cost.total")).data).toMatchObject({ value: 0 });
  });

  it("counts deployed agents", async () => {
    expect((await read("agents.deployed.count")).data).toEqual({ kind: "metric", value: 0 });

    // Set the status directly: deploying needs a connected provider, and the
    // aggregate is what is under test here, not the deploy endpoint.
    const { agents } = await import("@bridge/db");
    const { eq } = await import("drizzle-orm");
    await ctx.handle.db.update(agents).set({ status: "deployed" }).where(eq(agents.id, agentId));

    expect((await read("agents.deployed.count")).data).toEqual({ kind: "metric", value: 1 });
  });
});

describe("series sources", () => {
  it("returns one point per day including days with nothing", async () => {
    await seedRun();
    const { data } = await read("runs.count.daily");

    if (data.kind !== "series") throw new Error("expected a series");
    expect(data.points).toHaveLength(14);
    // Today is the last bucket and holds the run just seeded.
    expect(data.points.at(-1)?.value).toBe(1);
    expect(data.points.slice(0, -1).every((point) => point.value === 0)).toBe(true);
  });

  it("sums spend per day", async () => {
    await seedRun();
    await seedRun();
    const { data } = await read("runs.cost.daily");

    if (data.kind !== "series") throw new Error("expected a series");
    expect(data.points.at(-1)?.value).toBe(0.5);
  });
});

describe("row sources", () => {
  it("returns recent runs with columns", async () => {
    const id = await seedRun();
    const { data } = await read("runs.recent");

    if (data.kind !== "rows") throw new Error("expected rows");
    expect(data.columns).toContain("status");
    expect(data.rows[0]?.[0]).toBe(id);
  });

  it("filters the failed view to failures only", async () => {
    await seedRun({ status: "succeeded" });
    const failed = await seedRun({ status: "failed" });

    const { data } = await read("runs.failed.recent");
    if (data.kind !== "rows") throw new Error("expected rows");
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0]?.[0]).toBe(failed);
  });

  it("lists agents", async () => {
    const { data } = await read("agents.all");
    if (data.kind !== "rows") throw new Error("expected rows");
    expect(data.rows[0]).toContain("Helper");
  });
});

describe("the source catalogue is a boundary", () => {
  it("refuses a source that is not in the catalogue", async () => {
    expect((await read("runs.total;drop")).status).toBe(404);
    expect((await read("secrets.all")).status).toBe(404);
  });

  it("never returns another workspace's data", async () => {
    await seedRun();
    await seedRun();

    const other = await signUp(ctx.app, "other@example.com");
    const otherApi = as(ctx.app, other);
    const res = await otherApi(`/v1/workspaces/${other.workspaceId}/data/runs.total`);
    const body = (await res.json()) as { data: SourceData };

    expect(body.data).toEqual({ kind: "metric", value: 0 });
  });

  it("does not let one workspace read another's by id", async () => {
    const other = await signUp(ctx.app, "other@example.com");
    const res = await as(ctx.app, other)(`/v1/workspaces/${user.workspaceId}/data/runs.total`);
    expect(res.status).toBe(404);
  });
});
