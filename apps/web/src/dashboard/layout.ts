import type { Dashboard, DashboardPage, DashboardSection, Widget } from "../api.js";

/**
 * Every edit a dashboard can undergo, as plain functions over the document.
 *
 * The document is the dashboard — dragging a panel is an edit to it, exactly
 * like an AI rewriting it or someone typing JSON. Keeping these pure means the
 * grid never holds layout state of its own that could disagree with what gets
 * saved, and it means the fiddly parts (span arithmetic, id collisions,
 * reordering) can be tested without rendering anything.
 */
export const COLUMNS = 4;

/** How wide a widget sits when the document does not say. */
const NATURAL_WIDTH: Record<string, number> = {
  metric: 1,
  agentStatus: 1,
  approvalQueue: 1,
  text: 1,
  embed: 1,
  chat: 1,
  calendar: 2,
  chart: 2,
  table: 2,
  activity: 2,
  logs: 2,
  taskList: 2,
};

export const widgetSpan = (widget: Widget): number =>
  clampSpan(widget.w ?? NATURAL_WIDTH[widget.type] ?? 1);

export const widgetHeight = (widget: Widget): number => Math.min(Math.max(widget.h ?? 1, 1), 4);

export const clampSpan = (value: number): number =>
  Math.min(Math.max(Math.round(value) || 1, 1), COLUMNS);

/** Immutably rewrite one section, leaving the rest of the document alone. */
function mapSection(
  dashboard: Dashboard,
  pageId: string,
  sectionId: string,
  change: (section: DashboardSection) => DashboardSection,
): Dashboard {
  return {
    ...dashboard,
    pages: dashboard.pages.map((page) =>
      page.id !== pageId
        ? page
        : {
            ...page,
            sections: page.sections.map((section) =>
              section.id !== sectionId ? section : change(section),
            ),
          },
    ),
  };
}

/**
 * Ids must be unique within a page, so a duplicated widget cannot simply keep
 * the original's — React would key two panels the same and the schema would
 * reject the document.
 */
export function uniqueId(taken: Iterable<string>, base: string): string {
  const used = new Set(taken);
  const root = base.replace(/-\d+$/, "") || "widget";
  if (!used.has(root)) return root;
  for (let n = 2; n < 1000; n += 1) {
    if (!used.has(`${root}-${n}`)) return `${root}-${n}`;
  }
  return `${root}-${Date.now()}`;
}

export const widgetIds = (dashboard: Dashboard): string[] =>
  dashboard.pages.flatMap((page) => page.sections.flatMap((s) => s.widgets.map((w) => w.id)));

export function addWidget(
  dashboard: Dashboard,
  pageId: string,
  sectionId: string,
  widget: Widget,
): Dashboard {
  const id = uniqueId(widgetIds(dashboard), widget.id);
  return mapSection(dashboard, pageId, sectionId, (section) => ({
    ...section,
    widgets: [...section.widgets, { ...widget, id }],
  }));
}

export function removeWidget(dashboard: Dashboard, widgetId: string): Dashboard {
  return {
    ...dashboard,
    pages: dashboard.pages.map((page) => ({
      ...page,
      sections: page.sections.map((section) => ({
        ...section,
        widgets: section.widgets.filter((widget) => widget.id !== widgetId),
      })),
    })),
  };
}

export function updateWidget(
  dashboard: Dashboard,
  widgetId: string,
  patch: Partial<Widget>,
): Dashboard {
  return {
    ...dashboard,
    pages: dashboard.pages.map((page) => ({
      ...page,
      sections: page.sections.map((section) => ({
        ...section,
        widgets: section.widgets.map((widget) =>
          widget.id === widgetId ? ({ ...widget, ...patch } as Widget) : widget,
        ),
      })),
    })),
  };
}

export function duplicateWidget(dashboard: Dashboard, widgetId: string): Dashboard {
  const taken = widgetIds(dashboard);
  return {
    ...dashboard,
    pages: dashboard.pages.map((page) => ({
      ...page,
      sections: page.sections.map((section) => {
        const index = section.widgets.findIndex((widget) => widget.id === widgetId);
        if (index === -1) return section;
        const original = section.widgets[index] as Widget;
        const copy = { ...original, id: uniqueId(taken, original.id) };
        const widgets = [...section.widgets];
        widgets.splice(index + 1, 0, copy);
        return { ...section, widgets };
      }),
    })),
  };
}

/**
 * Move a widget to sit before `beforeId`, or to the end when that is null.
 *
 * Order is the only positioning this document has, so a move is a splice —
 * which is also why dropping onto a different section works without any
 * coordinate translation.
 */
export function moveWidget(
  dashboard: Dashboard,
  widgetId: string,
  target: { sectionId: string; beforeId: string | null },
): Dashboard {
  let moving: Widget | undefined;
  const without = {
    ...dashboard,
    pages: dashboard.pages.map((page) => ({
      ...page,
      sections: page.sections.map((section) => {
        const found = section.widgets.find((widget) => widget.id === widgetId);
        if (found) moving = found;
        return found
          ? { ...section, widgets: section.widgets.filter((w) => w.id !== widgetId) }
          : section;
      }),
    })),
  };
  if (!moving) return dashboard;
  const widget = moving;

  return {
    ...without,
    pages: without.pages.map((page) => ({
      ...page,
      sections: page.sections.map((section) => {
        if (section.id !== target.sectionId) return section;
        const widgets = [...section.widgets];
        const at = target.beforeId
          ? widgets.findIndex((one) => one.id === target.beforeId)
          : widgets.length;
        widgets.splice(at === -1 ? widgets.length : at, 0, widget);
        return { ...section, widgets };
      }),
    })),
  };
}

/**
 * Nudge a widget one place earlier or later within its section.
 *
 * Dragging is the obvious way to reorder and the only one a mouse offers, but
 * it is unusable from a keyboard and awkward on a touchscreen — so the same
 * rearrangement is reachable as a discrete action from the widget's menu.
 */
export function shiftWidget(dashboard: Dashboard, widgetId: string, delta: number): Dashboard {
  return {
    ...dashboard,
    pages: dashboard.pages.map((page) => ({
      ...page,
      sections: page.sections.map((section) => {
        const from = section.widgets.findIndex((widget) => widget.id === widgetId);
        if (from === -1) return section;
        const to = from + delta;
        if (to < 0 || to >= section.widgets.length) return section;
        const widgets = [...section.widgets];
        const [moving] = widgets.splice(from, 1);
        if (moving) widgets.splice(to, 0, moving);
        return { ...section, widgets };
      }),
    })),
  };
}

export function addPage(dashboard: Dashboard, title: string): Dashboard {
  const id = uniqueId(
    dashboard.pages.map((page) => page.id),
    slug(title),
  );
  const page: DashboardPage = {
    id,
    title,
    sections: [{ id: uniqueId([], "section"), widgets: [] }],
  };
  return { ...dashboard, pages: [...dashboard.pages, page] };
}

export function removePage(dashboard: Dashboard, pageId: string): Dashboard {
  // A dashboard with no pages cannot be saved, so the last one stays.
  if (dashboard.pages.length <= 1) return dashboard;
  return {
    ...dashboard,
    pages: dashboard.pages.filter((page) => page.id !== pageId),
    navigation: dashboard.navigation?.filter((id) => id !== pageId),
  };
}

export function renamePage(dashboard: Dashboard, pageId: string, title: string): Dashboard {
  return {
    ...dashboard,
    pages: dashboard.pages.map((page) => (page.id === pageId ? { ...page, title } : page)),
  };
}

export function addSection(dashboard: Dashboard, pageId: string, title: string): Dashboard {
  return {
    ...dashboard,
    pages: dashboard.pages.map((page) =>
      page.id !== pageId
        ? page
        : {
            ...page,
            sections: [
              ...page.sections,
              {
                id: uniqueId(
                  page.sections.map((section) => section.id),
                  slug(title) || "section",
                ),
                title,
                widgets: [],
              },
            ],
          },
    ),
  };
}

export const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "";

export function blankDashboard(name: string): Dashboard {
  return {
    version: 1,
    id: slug(name) || "dashboard",
    name,
    pages: [{ id: "home", title: "Home", sections: [{ id: "main", widgets: [] }] }],
  };
}

/** Ensures a set of dashboards all carry distinct ids before it is saved. */
export function withIds(dashboards: Dashboard[]): Dashboard[] {
  const taken: string[] = [];
  return dashboards.map((dashboard) => {
    const id = uniqueId(taken, dashboard.id || slug(dashboard.name) || "dashboard");
    taken.push(id);
    return { ...dashboard, id };
  });
}
