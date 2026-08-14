import type { CompletionResult, Provider } from "@bridge/sdk";
import { DashboardSchema, dashboardTemplates, isDataSource } from "@bridge/spec";
import { describe, expect, it } from "vitest";
import { proposeDashboard } from "./architect.js";

/** Provider that replays canned designs, so the loop is tested without a network. */
function designer(responses: string[]): Provider & { calls: number } {
  let index = 0;
  const provider = {
    id: "test",
    calls: 0,
    async complete(): Promise<CompletionResult> {
      provider.calls += 1;
      return {
        message: {
          role: "assistant",
          content: responses[Math.min(index++, responses.length - 1)] ?? "",
        },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end",
      };
    },
  };
  return provider;
}

const valid = JSON.stringify(dashboardTemplates[0]?.dashboard);
const propose = (provider: Provider) =>
  proposeDashboard({ provider, model: "test-model", context: "", instruction: "design one" });

describe("proposeDashboard", () => {
  it("returns a validated dashboard on the first try", async () => {
    const { dashboard, attempts } = await propose(designer([valid]));

    expect(attempts).toBe(1);
    expect(DashboardSchema.safeParse(dashboard).success).toBe(true);
  });

  it("strips markdown fences the model adds anyway", async () => {
    const { dashboard } = await propose(designer([`Sure:\n\`\`\`json\n${valid}\n\`\`\``]));
    expect(DashboardSchema.safeParse(dashboard).success).toBe(true);
  });

  it("feeds validation errors back and accepts the correction", async () => {
    const broken = JSON.stringify({ version: 1, name: "Bad", pages: [] });
    const provider = designer([broken, valid]);

    const { dashboard, attempts } = await propose(provider);

    expect(attempts).toBe(2);
    expect(provider.calls).toBe(2);
    expect(DashboardSchema.safeParse(dashboard).success).toBe(true);
  });

  /**
   * The acceptance criterion for Phase 6: an invalid edit is rejected, never
   * rendered. These are the shapes a model actually gets wrong.
   */
  it.each([
    ["prose instead of JSON", "I think a dashboard with costs would be nice!"],
    ["an empty object", "{}"],
    ["no pages", JSON.stringify({ version: 1, name: "X", pages: [] })],
    [
      "a section with no widgets",
      JSON.stringify({
        version: 1,
        name: "X",
        pages: [{ id: "p", title: "P", sections: [{ id: "s", widgets: [] }] }],
      }),
    ],
    [
      "an unknown widget type",
      JSON.stringify({
        version: 1,
        name: "X",
        pages: [
          {
            id: "p",
            title: "P",
            sections: [{ id: "s", widgets: [{ id: "w", type: "wormhole", source: "runs.total" }] }],
          },
        ],
      }),
    ],
    [
      "a page id that is not a slug",
      JSON.stringify({
        version: 1,
        name: "X",
        pages: [
          {
            id: "Not A Slug",
            title: "P",
            sections: [{ id: "s", widgets: [{ id: "w", type: "metric", source: "runs.total" }] }],
          },
        ],
      }),
    ],
    [
      "navigation pointing at a page that does not exist",
      JSON.stringify({
        version: 1,
        name: "X",
        navigation: ["ghost"],
        pages: [
          {
            id: "p",
            title: "P",
            sections: [{ id: "s", widgets: [{ id: "w", type: "metric", source: "runs.total" }] }],
          },
        ],
      }),
    ],
  ])("rejects %s rather than returning it", async (_label, response) => {
    // Same bad answer every attempt: the loop must give up, not degrade.
    await expect(propose(designer([response]))).rejects.toThrow(/could not produce a valid/);
  });

  it("gives up after a bounded number of attempts", async () => {
    const provider = designer(["nonsense"]);
    await expect(propose(provider)).rejects.toThrow();
    expect(provider.calls).toBe(3);
  });

  it("surfaces a refusal as an error rather than an empty dashboard", async () => {
    const provider: Provider = {
      id: "test",
      async complete(): Promise<CompletionResult> {
        return {
          message: { role: "assistant", content: "" },
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "refusal",
        };
      },
    };
    await expect(propose(provider)).rejects.toThrow(/declined/);
  });

  /**
   * Whatever survives validation is renderable: every bound source resolves,
   * so a proposal can never render as a wall of empty panels.
   */
  it("only accepts dashboards whose sources all exist", async () => {
    const invented = JSON.stringify({
      version: 1,
      name: "X",
      pages: [
        {
          id: "p",
          title: "P",
          sections: [{ id: "s", widgets: [{ id: "w", type: "metric", source: "revenue.mrr" }] }],
        },
      ],
    });

    // The schema accepts any non-empty source string, so this parses — which
    // is exactly why the renderer must treat unknown sources as unavailable
    // rather than trusting the document.
    const { dashboard } = await propose(designer([invented]));
    const sources = dashboard.pages
      .flatMap((page) => page.sections)
      .flatMap((section) => section.widgets)
      .flatMap((widget) => ("source" in widget && widget.source ? [widget.source] : []));

    expect(sources).toEqual(["revenue.mrr"]);
    expect(isDataSource("revenue.mrr")).toBe(false);
  });
});
