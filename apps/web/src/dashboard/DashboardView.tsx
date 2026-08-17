import { useState } from "react";
import type { Dashboard } from "../api.js";
import { Separator } from "../components/ui/separator.js";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs.js";
import { isWide, WidgetView } from "./widgets.jsx";

/**
 * The layout engine.
 *
 * Pages hold sections, sections hold widgets, and the grid is derived rather
 * than authored: a dashboard document says what to show, not where in pixels.
 * That is what lets an AI edit it safely — there are no coordinates to
 * corrupt, and any valid document lays out.
 *
 * Wide widgets (charts, tables, feeds) take the full row; compact ones
 * (metrics) flow three-up and collapse to one on a narrow window.
 */
export function DashboardView({
  workspaceId,
  dashboard,
}: {
  workspaceId: string;
  dashboard: Dashboard;
}) {
  const order = dashboard.navigation?.length
    ? dashboard.navigation
        .map((id) => dashboard.pages.find((page) => page.id === id))
        .filter((page): page is NonNullable<typeof page> => Boolean(page))
    : dashboard.pages;

  const [activePage, setActivePage] = useState(order[0]?.id ?? "");
  const page = order.find((candidate) => candidate.id === activePage) ?? order[0];

  if (!page) return null;

  return (
    <div className="flex flex-col gap-6">
      {order.length > 1 && (
        <Tabs value={page.id} onValueChange={setActivePage}>
          <TabsList
            className="flex max-w-full justify-start overflow-x-auto"
            aria-label="Dashboard pages"
          >
            {order.map((candidate) => (
              <TabsTrigger key={candidate.id} value={candidate.id}>
                {candidate.title}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      )}

      {page.sections.map((section) => (
        <section key={section.id} className="flex flex-col gap-3">
          {section.title && (
            <div className="flex items-center gap-3">
              <h2 className="text-sm font-semibold text-foreground">{section.title}</h2>
              <Separator className="flex-1" />
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {section.widgets.map((widget) => (
              <div
                key={widget.id}
                className={isWide(widget) ? "sm:col-span-2 lg:col-span-3" : undefined}
              >
                <WidgetView workspaceId={workspaceId} widget={widget} />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
