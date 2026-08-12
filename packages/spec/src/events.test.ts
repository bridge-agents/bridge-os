import { describe, expect, it } from "vitest";
import { DashboardSchema } from "./dashboard.js";
import { BridgeEventSchema, createEvent } from "./events.js";
import { TemplateSchema } from "./template.js";
import { personalAssistantTemplate } from "./templates/personal-assistant.js";

describe("events", () => {
  it("createEvent produces a valid envelope", () => {
    const event = createEvent("run.started", {
      workspaceId: "ws_1",
      agentId: "agt_1",
      runId: "run_1",
      data: { trigger: "manual" },
    });
    expect(BridgeEventSchema.parse(event)).toEqual(event);
    expect(event.id).toMatch(/^evt_/);
  });

  it("rejects unknown event types", () => {
    const result = BridgeEventSchema.safeParse({
      id: "evt_x",
      type: "agent.exploded",
      ts: new Date().toISOString(),
      workspaceId: "ws_1",
    });
    expect(result.success).toBe(false);
  });
});

describe("dashboard", () => {
  it("rejects navigation to unknown pages", () => {
    const dashboard = structuredClone(personalAssistantTemplate.manifest.dashboard);
    expect(dashboard).toBeDefined();
    const result = DashboardSchema.safeParse({ ...dashboard, navigation: ["missing-page"] });
    expect(result.success).toBe(false);
  });
});

describe("templates", () => {
  it("the reference template validates as data", () => {
    expect(TemplateSchema.parse(personalAssistantTemplate).id).toBe("personal-assistant");
  });
});
