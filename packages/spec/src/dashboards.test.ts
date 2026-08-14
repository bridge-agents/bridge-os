import { describe, expect, it } from "vitest";
import { DashboardSchema } from "./dashboard.js";
import { blankDashboard, dashboardTemplates, getDashboardTemplate } from "./dashboards.js";
import { isDataSource } from "./sources.js";

/**
 * Templates are ordinary dashboards, so they must survive the same validation
 * as anything a user or the AI produces — and must not reference data that
 * does not exist, which would ship a dead panel.
 */
describe("dashboard templates", () => {
  it.each(dashboardTemplates.map((template) => [template.id, template] as const))(
    "%s parses against the schema",
    (_id, template) => {
      const parsed = DashboardSchema.safeParse(template.dashboard);
      expect(parsed.success).toBe(true);
    },
  );

  it.each(dashboardTemplates.map((template) => [template.id, template] as const))(
    "%s only binds to sources that exist",
    (_id, template) => {
      const sources = template.dashboard.pages
        .flatMap((page) => page.sections)
        .flatMap((section) => section.widgets)
        .flatMap((widget) => ("source" in widget && widget.source ? [widget.source] : []));

      expect(sources.length).toBeGreaterThan(0);
      for (const source of sources) {
        expect(isDataSource(source), `${source} is not in the catalogue`).toBe(true);
      }
    },
  );

  it("survives a round trip through the schema unchanged", () => {
    for (const template of dashboardTemplates) {
      const parsed = DashboardSchema.parse(template.dashboard);
      expect(DashboardSchema.parse(parsed)).toEqual(parsed);
    }
  });

  it("looks templates up by id", () => {
    expect(getDashboardTemplate("overview")?.name).toBe("Overview");
    expect(getDashboardTemplate("nope")).toBeUndefined();
  });

  it("gives unique widget ids within a page", () => {
    for (const template of dashboardTemplates) {
      for (const page of template.dashboard.pages) {
        const ids = page.sections.flatMap((section) => section.widgets.map((w) => w.id));
        expect(new Set(ids).size, `${template.id}/${page.id} repeats a widget id`).toBe(ids.length);
      }
    }
  });
});

describe("blankDashboard", () => {
  it("is valid, which is what makes 'start from scratch' safe", () => {
    expect(DashboardSchema.safeParse(blankDashboard()).success).toBe(true);
  });

  it("takes a name", () => {
    expect(blankDashboard("Mine").name).toBe("Mine");
  });
});
