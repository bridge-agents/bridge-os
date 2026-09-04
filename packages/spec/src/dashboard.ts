import { z } from "zod";
import { SlugSchema } from "./common.js";

/**
 * Dashboards are schema, never hard-coded frontend source. Pages contain
 * sections, sections contain widgets, widgets bind to named data sources.
 * The renderer arrives in Phase 6; templates and the AI editor target this
 * schema from day one.
 */

/**
 * Size is a span, never a coordinate.
 *
 * A widget says how many columns of a four-column grid it wants and how tall
 * it stands; where it lands is decided by the order it sits in. That keeps the
 * property that made this document safe for an AI to write — there is no
 * position to corrupt, no overlap to resolve, and every valid document lays
 * out — while still letting someone drag a panel wider because the numbers
 * beside it deserve the room.
 */
const widgetBase = {
  id: SlugSchema,
  title: z.string().optional(),
  /** Columns spanned, out of four. Omitted means the type's natural width. */
  w: z.number().int().min(1).max(4).optional(),
  /** Rows spanned. Omitted means one. */
  h: z.number().int().min(1).max(4).optional(),
};

/** Named API data binding, e.g. "runs.cost.daily" or "tasks.open". Resolved by the renderer. */
const Source = z.string().min(1);

export const WidgetSchema = z.discriminatedUnion("type", [
  z.object({ ...widgetBase, type: z.literal("metric"), source: Source }),
  z.object({
    ...widgetBase,
    type: z.literal("chart"),
    source: Source,
    chartType: z.enum(["line", "bar", "area"]).default("line"),
  }),
  z.object({ ...widgetBase, type: z.literal("taskList"), source: Source.default("tasks.open") }),
  z.object({ ...widgetBase, type: z.literal("agentStatus"), agent: z.string().optional() }),
  z.object({ ...widgetBase, type: z.literal("activity"), source: Source.default("events.recent") }),
  z.object({ ...widgetBase, type: z.literal("calendar"), source: Source.default("calendar") }),
  z.object({ ...widgetBase, type: z.literal("table"), source: Source }),
  z.object({ ...widgetBase, type: z.literal("approvalQueue") }),
  z.object({ ...widgetBase, type: z.literal("chat"), agent: z.string().optional() }),
  z.object({ ...widgetBase, type: z.literal("logs"), source: Source.default("logs.recent") }),
  z.object({ ...widgetBase, type: z.literal("text"), content: z.string() }),
  z.object({ ...widgetBase, type: z.literal("embed"), url: z.url() }),
]);
export type Widget = z.infer<typeof WidgetSchema>;

export const DashboardSectionSchema = z.object({
  id: SlugSchema,
  title: z.string().optional(),
  /**
   * Empty is allowed. It was not when only templates and the AI wrote these —
   * an empty section then meant a mistake — but someone building a dashboard
   * by hand adds the page before the panels that go on it, and a document you
   * cannot save halfway through building is a document you lose.
   */
  widgets: z.array(WidgetSchema).default([]),
});

export const DashboardPageSchema = z.object({
  id: SlugSchema,
  title: z.string().min(1),
  icon: z.string().optional(),
  sections: z.array(DashboardSectionSchema).min(1),
});

/**
 * User-customisable appearance only. The Bridge logo, name, and core design
 * language are not part of the theme and cannot be overridden.
 */
export const DashboardThemeSchema = z.object({
  accent: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default("#C6C6CE"),
  background: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  appearance: z.enum(["dark", "light", "system"]).default("dark"),
});

export const DashboardSchema = z
  .object({
    version: z.literal(1),
    /**
     * Stable handle for switching between dashboards. Optional because
     * documents written before there could be more than one do not carry it,
     * and because the AI should not have to invent one — everything Bridge
     * itself writes fills it in.
     */
    id: SlugSchema.optional(),
    name: z.string().min(1),
    theme: DashboardThemeSchema.prefault({}),
    pages: z.array(DashboardPageSchema).min(1),
    /** Ordered page ids for navigation; defaults to page order. */
    navigation: z.array(SlugSchema).optional(),
  })
  .superRefine((dashboard, ctx) => {
    const pageIds = new Set(dashboard.pages.map((p) => p.id));
    if (pageIds.size !== dashboard.pages.length) {
      ctx.addIssue({ code: "custom", message: "duplicate page ids", path: ["pages"] });
    }
    for (const nav of dashboard.navigation ?? []) {
      if (!pageIds.has(nav)) {
        ctx.addIssue({
          code: "custom",
          message: `navigation references unknown page "${nav}"`,
          path: ["navigation"],
        });
      }
    }
  });
export type Dashboard = z.infer<typeof DashboardSchema>;
