import { useState } from "react";
import type { Dashboard } from "../api.js";
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
        <nav className="flex flex-wrap gap-1" aria-label="Dashboard pages">
          {order.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              onClick={() => setActivePage(candidate.id)}
              aria-current={candidate.id === page.id ? "page" : undefined}
              className={`rounded-[var(--radius-sm)] px-2.5 py-1 font-condensed text-[12px] font-semibold uppercase tracking-[0.08em] transition ${
                candidate.id === page.id
                  ? "bg-bg-overlay text-text"
                  : "text-text-muted hover:bg-bg-overlay/60 hover:text-text"
              }`}
            >
              {candidate.title}
            </button>
          ))}
        </nav>
      )}

      {page.sections.map((section) => (
        <section key={section.id} className="flex flex-col gap-3">
          {section.title && (
            <div className="flex items-center gap-3">
              <h2 className="font-condensed text-[13px] font-semibold uppercase tracking-[0.1em] text-text">
                {section.title}
              </h2>
              <span className="dimension" aria-hidden="true" />
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
