import { DashboardSchema } from "@bridge/spec";
import { describe, expect, it } from "vitest";
import type { Dashboard, Widget } from "../api.js";
import {
  addPage,
  addWidget,
  blankDashboard,
  COLUMNS,
  clampSpan,
  duplicateWidget,
  moveWidget,
  removePage,
  removeWidget,
  shiftWidget,
  uniqueId,
  updateWidget,
  widgetIds,
  widgetSpan,
  withIds,
} from "./layout.js";

/**
 * Editing a dashboard is editing its document, so the bar every one of these
 * has to clear is the same one the server applies: whatever comes out still
 * parses. A drag that produces an unsaveable document is worse than a drag
 * that does nothing.
 */
const base = (): Dashboard => ({
  version: 1,
  id: "ops",
  name: "Ops",
  pages: [
    {
      id: "home",
      title: "Home",
      sections: [
        {
          id: "top",
          widgets: [
            { id: "a", type: "metric", source: "runs.total" },
            { id: "b", type: "metric", source: "runs.active" },
            { id: "c", type: "chart", source: "runs.cost.daily" },
          ],
        },
        { id: "bottom", widgets: [{ id: "d", type: "activity", source: "events.recent" }] },
      ],
    },
  ],
});

const valid = (dashboard: Dashboard) => DashboardSchema.safeParse(dashboard).success;
const idsIn = (dashboard: Dashboard, sectionId: string) =>
  dashboard.pages[0]?.sections.find((s) => s.id === sectionId)?.widgets.map((w) => w.id);

describe("sizing", () => {
  it("gives each widget a sensible natural width", () => {
    expect(widgetSpan({ id: "x", type: "metric" })).toBe(1);
    expect(widgetSpan({ id: "x", type: "chart" })).toBe(2);
    expect(widgetSpan({ id: "x", type: "table" })).toBe(2);
  });

  it("prefers what the document says over the natural width", () => {
    expect(widgetSpan({ id: "x", type: "metric", w: 4 })).toBe(4);
  });

  /** A drag reports fractional columns, and can be dragged past either end. */
  it.each([
    [-3, 1],
    [0, 1],
    [1.4, 1],
    [2.6, 3],
    [9, COLUMNS],
  ])("clamps %s to %s", (input, expected) => {
    expect(clampSpan(input)).toBe(expected);
  });

  it("never produces a width the schema rejects", () => {
    for (const w of [-5, 0, 1.5, 7, 99]) {
      const next = updateWidget(base(), "a", { w: clampSpan(w) });
      expect(valid(next), `w=${w}`).toBe(true);
    }
  });
});

describe("moving", () => {
  it("drops a widget before its target", () => {
    const next = moveWidget(base(), "c", { sectionId: "top", beforeId: "a" });
    expect(idsIn(next, "top")).toEqual(["c", "a", "b"]);
    expect(valid(next)).toBe(true);
  });

  it("drops a widget at the end when there is no target", () => {
    const next = moveWidget(base(), "a", { sectionId: "top", beforeId: null });
    expect(idsIn(next, "top")).toEqual(["b", "c", "a"]);
  });

  /** Sections are just groups; a widget can be dragged out of one. */
  it("moves a widget into a different section", () => {
    const next = moveWidget(base(), "a", { sectionId: "bottom", beforeId: "d" });
    expect(idsIn(next, "top")).toEqual(["b", "c"]);
    expect(idsIn(next, "bottom")).toEqual(["a", "d"]);
    expect(valid(next)).toBe(true);
  });

  it("does not duplicate the widget it moves", () => {
    const next = moveWidget(base(), "b", { sectionId: "bottom", beforeId: null });
    expect(widgetIds(next).filter((id) => id === "b")).toHaveLength(1);
  });

  it("leaves the document alone when the widget is unknown", () => {
    expect(moveWidget(base(), "nope", { sectionId: "top", beforeId: "a" })).toEqual(base());
  });

  it.each([
    ["a", 1, ["b", "a", "c"]],
    ["c", -1, ["a", "c", "b"]],
    ["a", -1, ["a", "b", "c"]],
    ["c", 1, ["a", "b", "c"]],
  ])("shifts %s by %s", (id, delta, expected) => {
    expect(idsIn(shiftWidget(base(), id, delta), "top")).toEqual(expected);
  });
});

describe("adding and removing", () => {
  it("adds a widget to the section asked for", () => {
    const widget: Widget = { id: "new", type: "metric", source: "runs.total" };
    const next = addWidget(base(), "home", "bottom", widget);
    expect(idsIn(next, "bottom")).toEqual(["d", "new"]);
    expect(valid(next)).toBe(true);
  });

  /** Ids must stay unique or the schema rejects the page. */
  it("renames a widget whose id is already taken", () => {
    const next = addWidget(base(), "home", "top", {
      id: "a",
      type: "metric",
      source: "runs.total",
    });
    expect(idsIn(next, "top")).toEqual(["a", "b", "c", "a-2"]);
    expect(valid(next)).toBe(true);
  });

  it("duplicates a widget beside the original with a fresh id", () => {
    const next = duplicateWidget(base(), "b");
    expect(idsIn(next, "top")).toEqual(["a", "b", "b-2", "c"]);
    expect(valid(next)).toBe(true);
  });

  it("removes a widget and nothing else", () => {
    const next = removeWidget(base(), "b");
    expect(idsIn(next, "top")).toEqual(["a", "c"]);
    expect(idsIn(next, "bottom")).toEqual(["d"]);
    expect(valid(next)).toBe(true);
  });

  it("edits a widget's properties in place", () => {
    const next = updateWidget(base(), "c", { chartType: "bar", title: "Spend" });
    const widget = next.pages[0]?.sections[0]?.widgets[2];
    expect(widget).toMatchObject({ id: "c", chartType: "bar", title: "Spend" });
    expect(valid(next)).toBe(true);
  });
});

describe("pages", () => {
  it("adds a page with somewhere to put widgets", () => {
    const next = addPage(base(), "Costs");
    expect(next.pages).toHaveLength(2);
    expect(next.pages[1]?.sections).toHaveLength(1);
    expect(valid(next)).toBe(true);
  });

  it("removes a page", () => {
    const next = removePage(addPage(base(), "Costs"), "costs");
    expect(next.pages.map((page) => page.id)).toEqual(["home"]);
  });

  /** The schema requires at least one page, so the last one cannot go. */
  it("refuses to remove the only page", () => {
    const next = removePage(base(), "home");
    expect(next.pages).toHaveLength(1);
    expect(valid(next)).toBe(true);
  });
});

describe("dashboard identity", () => {
  it("gives every dashboard a distinct id", () => {
    const list = withIds([
      { ...base(), id: undefined, name: "Ops" },
      { ...base(), id: undefined, name: "Ops" },
      { ...base(), id: undefined, name: "Costs" },
    ]);
    expect(list.map((one) => one.id)).toEqual(["ops", "ops-2", "costs"]);
  });

  it("builds an empty dashboard the schema accepts", () => {
    expect(valid(blankDashboard("Fresh"))).toBe(true);
  });

  it("finds a free id given the taken ones", () => {
    expect(uniqueId(["a", "a-2"], "a")).toBe("a-3");
    expect(uniqueId([], "brand-new")).toBe("brand-new");
  });
});
