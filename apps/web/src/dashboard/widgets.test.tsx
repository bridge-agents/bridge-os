import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceData, Widget } from "../api.js";
import { isWide, WidgetView } from "./widgets.jsx";

/**
 * Data-binding tests for the widget registry.
 *
 * The contract under test is the one that keeps an AI-authored dashboard
 * honest: a widget shows what the source actually returned, and says so
 * plainly when it cannot — it never renders a plausible-looking zero.
 */
const responses = new Map<string, SourceData | "reject">();

beforeEach(() => {
  responses.clear();
  vi.stubGlobal("fetch", async (url: string | URL) => {
    const source = String(url).split("/data/")[1] ?? "";
    const answer = responses.get(source);

    if (!answer || answer === "reject") {
      return new Response(JSON.stringify({ error: { code: "not_found", message: "no" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ data: answer }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const show = (widget: Widget) =>
  render(
    <MemoryRouter>
      <WidgetView workspaceId="ws_1" widget={widget} />
    </MemoryRouter>,
  );

describe("metric widget", () => {
  it("renders the number the source returned", async () => {
    responses.set("runs.total", { kind: "metric", value: 42 });
    show({ id: "w", type: "metric", title: "Runs", source: "runs.total" });

    expect(await screen.findByText("42")).toBeTruthy();
  });

  it("formats money as money", async () => {
    responses.set("runs.cost.total", { kind: "metric", value: 12.5, unit: "usd" });
    show({ id: "w", type: "metric", source: "runs.cost.total" });

    expect(await screen.findByText("$12.50")).toBeTruthy();
  });

  it("keeps small amounts legible rather than rounding them to zero", async () => {
    responses.set("runs.cost.total", { kind: "metric", value: 0.0023, unit: "usd" });
    show({ id: "w", type: "metric", source: "runs.cost.total" });

    expect(await screen.findByText("$0.0023")).toBeTruthy();
  });

  it("says the source is missing instead of showing zero", async () => {
    responses.set("revenue.mrr", "reject");
    show({ id: "w", type: "metric", title: "MRR", source: "revenue.mrr" });

    // The distinction that matters: a real zero and a missing binding must
    // never look the same.
    expect(await screen.findByText(/No source called "revenue.mrr"/)).toBeTruthy();
    expect(screen.queryByText("0")).toBeNull();
  });

  it("refuses to render a series as a single number", async () => {
    responses.set("runs.count.daily", {
      kind: "series",
      points: [{ label: "2026-01-01", value: 3 }],
    });
    show({ id: "w", type: "metric", source: "runs.count.daily" });

    expect(await screen.findByText(/is not a single number/)).toBeTruthy();
  });
});

describe("chart widget", () => {
  it("plots the points it was given", async () => {
    responses.set("runs.count.daily", {
      kind: "series",
      points: [
        { label: "2026-01-01", value: 1 },
        { label: "2026-01-02", value: 4 },
      ],
    });
    show({ id: "w", type: "chart", source: "runs.count.daily", chartType: "bar" });

    // The axis label states the peak, which is how the chart is read.
    expect(await screen.findByText("peak 4")).toBeTruthy();
    expect(screen.getByText("2026-01-01")).toBeTruthy();
  });

  it("refuses to plot something that is not a series", async () => {
    responses.set("runs.total", { kind: "metric", value: 9 });
    show({ id: "w", type: "chart", source: "runs.total" });

    expect(await screen.findByText(/has no series to plot/)).toBeTruthy();
  });
});

describe("row widgets", () => {
  it("renders columns and cells", async () => {
    responses.set("runs.recent", {
      kind: "rows",
      columns: ["run", "status"],
      rows: [["run_1", "succeeded"]],
    });
    show({ id: "w", type: "table", source: "runs.recent" });

    expect(await screen.findByText("run_1")).toBeTruthy();
    expect(screen.getByText("succeeded")).toBeTruthy();
    expect(screen.getByText("status")).toBeTruthy();
  });

  it("says so when there is genuinely nothing", async () => {
    responses.set("runs.recent", { kind: "rows", columns: ["run"], rows: [] });
    show({ id: "w", type: "table", source: "runs.recent" });

    expect(await screen.findByText("Nothing yet.")).toBeTruthy();
  });

  it("shares one renderer across the row-shaped widget types", async () => {
    responses.set("events.recent", {
      kind: "rows",
      columns: ["event"],
      rows: [["agent.deployed"]],
    });
    show({ id: "w", type: "activity", source: "events.recent" });

    expect(await screen.findByText("agent.deployed")).toBeTruthy();
  });
});

describe("widgets with no data binding", () => {
  it("renders text content as written", () => {
    show({ id: "w", type: "text", content: "Ship on Friday" });
    expect(screen.getByText("Ship on Friday")).toBeTruthy();
  });

  /**
   * Embeds are links, never iframes: a dashboard can be model-authored or
   * imported with an agent, and framing a URL it chose would hand a
   * third-party page a window inside the app.
   */
  it("renders an embed as a link, not an iframe", () => {
    const { container } = show({ id: "w", type: "embed", url: "https://example.com/board" });

    expect(container.querySelector("iframe")).toBeNull();
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://example.com/board");
    expect(link?.getAttribute("rel")).toContain("noopener");
  });

  it("does not crash on a widget type it has never seen", () => {
    show({ id: "w", type: "hologram", title: "From the future" } as Widget);
    expect(screen.getByText(/not available in this version/)).toBeTruthy();
  });
});

/*
 * Not covered here: the 15s refresh interval. Driving it needs fake timers
 * installed before mount, which deadlocks testing-library's async helpers —
 * the test ends up exercising the harness rather than the widget. The
 * refresh is verified in the running app instead.
 */
describe("layout hints", () => {
  it("gives full width to widgets that need it", () => {
    expect(isWide({ id: "a", type: "table", source: "runs.recent" })).toBe(true);
    expect(isWide({ id: "b", type: "chart", source: "runs.count.daily" })).toBe(true);
    expect(isWide({ id: "c", type: "metric", source: "runs.total" })).toBe(false);
  });
});
