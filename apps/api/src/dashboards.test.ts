import { workspaceDashboards } from "@bridge/db";
import type { Dashboard } from "@bridge/spec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readDashboards } from "./dashboards.js";
import { as, createTestApp, signUp, type TestApp, type TestUser } from "./testing.js";

let ctx: TestApp;
let user: TestUser;
let api: ReturnType<typeof as>;

const dashboard = (id: string, name = id): Dashboard =>
  ({
    version: 1,
    id,
    name,
    theme: { accent: "#C6C6CE", appearance: "system" },
    pages: [
      {
        id: "home",
        title: "Home",
        sections: [
          { id: "main", widgets: [{ id: "total", type: "metric", source: "runs.total" }] },
        ],
      },
    ],
  }) as Dashboard;

const url = () => `/v1/workspaces/${user.workspaceId}/dashboard`;

beforeEach(async () => {
  ctx = await createTestApp();
  user = await signUp(ctx.app, "owner@example.com");
  api = as(ctx.app, user);
});
afterEach(async () => {
  await ctx.close();
});

describe("workspace dashboards", () => {
  it("starts with none", async () => {
    const body = (await (await api(url())).json()) as { dashboards: Dashboard[] };
    expect(body.dashboards).toEqual([]);
  });

  it("saves several and reads them back in order", async () => {
    const saved = await api(url(), {
      method: "PUT",
      body: JSON.stringify([dashboard("ops", "Operations"), dashboard("spend", "Spend")]),
    });
    expect(saved.status).toBe(200);

    const body = (await (await api(url())).json()) as { dashboards: Dashboard[] };
    expect(body.dashboards.map((one) => one.name)).toEqual(["Operations", "Spend"]);
  });

  /**
   * Two dashboards sharing an id would make switching ambiguous — the tab bar
   * and the URL both key on it — so the server refuses rather than storing a
   * set it cannot address.
   */
  it("refuses two dashboards with the same id", async () => {
    const res = await api(url(), {
      method: "PUT",
      body: JSON.stringify([dashboard("ops"), dashboard("ops")]),
    });
    expect(res.status).toBe(422);
  });

  it("still accepts a single dashboard from an older client", async () => {
    const res = await api(url(), { method: "PUT", body: JSON.stringify(dashboard("solo")) });
    expect(res.status).toBe(200);

    const body = (await (await api(url())).json()) as {
      dashboards: Dashboard[];
      dashboard: Dashboard | null;
    };
    expect(body.dashboards).toHaveLength(1);
    // The old field stays populated so an older client keeps rendering.
    expect(body.dashboard?.id).toBe("solo");
  });

  /**
   * Rows written before dashboards could be plural hold a bare object. They
   * must keep opening: this is the upgrade path for every existing install.
   */
  it("reads a row stored by the previous version", async () => {
    await ctx.handle.db
      .insert(workspaceDashboards)
      .values({ workspaceId: user.workspaceId, document: dashboard("legacy", "Legacy") });

    const body = (await (await api(url())).json()) as { dashboards: Dashboard[] };
    expect(body.dashboards).toHaveLength(1);
    expect(body.dashboards[0]?.name).toBe("Legacy");
  });

  it("keeps one workspace's dashboards out of another's", async () => {
    await api(url(), { method: "PUT", body: JSON.stringify([dashboard("ops")]) });

    const other = await signUp(ctx.app, "other@example.com");
    const otherApi = as(ctx.app, other);
    const body = (await (
      await otherApi(`/v1/workspaces/${other.workspaceId}/dashboard`)
    ).json()) as { dashboards: Dashboard[] };
    expect(body.dashboards).toEqual([]);
  });
});

describe("readDashboards", () => {
  it("passes a list through", () => {
    expect(readDashboards([dashboard("a"), dashboard("b")])).toHaveLength(2);
  });

  it("wraps a single stored document", () => {
    expect(readDashboards(dashboard("a"))).toHaveLength(1);
  });

  it("treats anything unreadable as none, rather than throwing", () => {
    expect(readDashboards(null)).toEqual([]);
    expect(readDashboards({ nonsense: true })).toEqual([]);
  });
});
