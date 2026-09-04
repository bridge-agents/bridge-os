import { ArrowLeft, ArrowRight, Copy, GripVertical, Pencil, Plus, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import type { Dashboard, Widget } from "../api.js";
import { Button } from "../components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.js";
import { Separator } from "../components/ui/separator.js";
import { COLUMNS, clampSpan, widgetHeight, widgetSpan } from "./layout.js";
import { WidgetView } from "./widgets.jsx";

/**
 * The grid.
 *
 * Four columns, and a widget occupies as many as its document asks for. There
 * are still no coordinates: position comes from order and size from a span, so
 * every valid document lays out and a drag can never produce an overlap or a
 * hole that has to be resolved later.
 *
 * Editing is the same view with handles switched on, deliberately — a preview
 * that lays out differently from the editor is a preview of nothing.
 */
interface EditHandlers {
  onMove: (widgetId: string, target: { sectionId: string; beforeId: string | null }) => void;
  /** Discrete reorder, so rearranging never requires a mouse drag. */
  onShift: (widgetId: string, delta: number) => void;
  onResize: (widgetId: string, w: number) => void;
  onEdit: (widget: Widget) => void;
  onDuplicate: (widgetId: string) => void;
  onRemove: (widgetId: string) => void;
  onAdd: (sectionId: string) => void;
}

const SPAN_CLASS: Record<number, string> = {
  1: "sm:col-span-2 lg:col-span-1",
  2: "sm:col-span-2",
  3: "sm:col-span-2 lg:col-span-3",
  4: "sm:col-span-2 lg:col-span-4",
};

const HEIGHT_CLASS: Record<number, string> = {
  1: "min-h-[8.5rem]",
  2: "min-h-[17rem]",
  3: "min-h-[25rem]",
  4: "min-h-[33rem]",
};

function Cell({
  workspaceId,
  widget,
  sectionId,
  edit,
  dragging,
  onDragState,
}: {
  workspaceId: string;
  widget: Widget;
  sectionId: string;
  edit?: EditHandlers;
  dragging: string | null;
  onDragState: (id: string | null) => void;
}) {
  const span = widgetSpan(widget);
  const height = widgetHeight(widget);
  const cell = useRef<HTMLLIElement>(null);
  const [over, setOver] = useState(false);

  /**
   * Resizing measures the grid rather than the pointer's raw delta, so a drag
   * lands on the column the cursor is actually over at any window width.
   */
  const startResize = (event: React.PointerEvent) => {
    event.preventDefault();
    const grid = cell.current?.parentElement;
    if (!grid) return;
    const gridLeft = grid.getBoundingClientRect().left;
    const columnWidth = grid.getBoundingClientRect().width / COLUMNS;
    const left = (cell.current?.getBoundingClientRect().left ?? gridLeft) - gridLeft;

    const move = (pointer: PointerEvent) => {
      const width = pointer.clientX - gridLeft - left;
      edit?.onResize(widget.id, clampSpan(width / columnWidth));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };

  return (
    /**
     * A section is a list of panels, and this is one of them. Drag-and-drop
     * has no semantic element of its own, so the markup describes the content
     * and the widget's menu carries the keyboard equivalent of a drag.
     */
    <li
      ref={cell}
      data-widget={widget.id}
      className={`group/cell relative list-none ${SPAN_CLASS[span] ?? ""} ${HEIGHT_CLASS[height] ?? ""} ${
        dragging === widget.id ? "opacity-40" : ""
      } ${over ? "before:absolute before:-left-1.5 before:top-0 before:h-full before:w-0.5 before:rounded-full before:bg-primary" : ""}`}
      draggable={Boolean(edit)}
      onDragStart={(event) => {
        // Optional: the cursor hint is a nicety, and losing it must not stop
        // the drag from being registered.
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
        onDragState(widget.id);
      }}
      onDragEnd={() => onDragState(null)}
      onDragOver={(event) => {
        if (!edit || !dragging || dragging === widget.id) return;
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        if (!edit || !dragging) return;
        event.preventDefault();
        /**
         * The section behind this cell also accepts drops, to append when you
         * aim at empty space. Without this the drop runs twice — landing here
         * first, then being appended to the end by the container, so a widget
         * dragged onto a neighbour would silently jump to the bottom instead.
         */
        event.stopPropagation();
        setOver(false);
        edit.onMove(dragging, { sectionId, beforeId: widget.id });
        onDragState(null);
      }}
    >
      <div className="h-full [&>*]:h-full">
        <WidgetView workspaceId={workspaceId} widget={widget} />
      </div>

      {edit && (
        <>
          <div className="absolute right-1.5 top-1.5 flex items-center gap-0.5 rounded-md border bg-background/95 opacity-0 shadow-sm backdrop-blur transition group-hover/cell:opacity-100 focus-within:opacity-100">
            <span
              className="flex size-7 cursor-grab items-center justify-center text-muted-foreground active:cursor-grabbing"
              aria-hidden
            >
              <GripVertical className="size-3.5" />
            </span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Options for ${widget.title ?? widget.type}`}
                >
                  <Pencil className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => edit.onEdit(widget)}>
                  <Pencil /> Edit
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => edit.onDuplicate(widget.id)}>
                  <Copy /> Duplicate
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => edit.onShift(widget.id, -1)}>
                  <ArrowLeft /> Move earlier
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => edit.onShift(widget.id, 1)}>
                  <ArrowRight /> Move later
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {[1, 2, 3, 4].map((width) => (
                  <DropdownMenuItem
                    key={width}
                    onClick={() => edit.onResize(widget.id, width)}
                    className={span === width ? "bg-accent" : undefined}
                  >
                    {["Quarter width", "Half width", "Three quarters", "Full width"][width - 1]}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={() => edit.onRemove(widget.id)}>
                  <Trash2 /> Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Drag the right edge to change how many columns this takes. */}
          <button
            type="button"
            aria-label={`Resize ${widget.title ?? widget.type}`}
            onPointerDown={startResize}
            onKeyDown={(event) => {
              // Clamped here as well as on drag: arrowing past either end must
              // not write a span the schema rejects.
              if (event.key === "ArrowRight") edit.onResize(widget.id, clampSpan(span + 1));
              if (event.key === "ArrowLeft") edit.onResize(widget.id, clampSpan(span - 1));
            }}
            className="absolute -right-1 top-1/2 h-12 w-2 -translate-y-1/2 cursor-col-resize rounded-full bg-primary/0 transition group-hover/cell:bg-primary/30 hover:bg-primary/60 focus-visible:bg-primary/60 focus-visible:outline-none"
          />
        </>
      )}
    </li>
  );
}

export function DashboardView({
  workspaceId,
  dashboard,
  activePage,
  onPageChange,
  edit,
}: {
  workspaceId: string;
  dashboard: Dashboard;
  activePage?: string;
  onPageChange?: (pageId: string) => void;
  edit?: EditHandlers;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  const order = dashboard.navigation?.length
    ? dashboard.navigation
        .map((id) => dashboard.pages.find((page) => page.id === id))
        .filter((page): page is NonNullable<typeof page> => Boolean(page))
    : dashboard.pages;

  const [internalPage, setInternalPage] = useState(order[0]?.id ?? "");
  const currentId = activePage ?? internalPage;
  const page = order.find((candidate) => candidate.id === currentId) ?? order[0];
  const select = onPageChange ?? setInternalPage;

  if (!page) return null;

  return (
    <div className="flex flex-col gap-6">
      {order.length > 1 && (
        <div
          className="flex max-w-full gap-1 overflow-x-auto border-b pb-px"
          role="tablist"
          aria-label="Dashboard pages"
        >
          {order.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              role="tab"
              aria-selected={candidate.id === page.id}
              onClick={() => select(candidate.id)}
              className={`-mb-px shrink-0 border-b-2 px-3 py-2 text-sm transition ${
                candidate.id === page.id
                  ? "border-primary font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {candidate.title}
            </button>
          ))}
        </div>
      )}

      {page.sections.map((section) => (
        <section key={section.id} className="flex flex-col gap-3">
          {(section.title || edit) && (
            <div className="flex items-center gap-3">
              {section.title && (
                <h3 className="shrink-0 text-sm font-semibold text-foreground">{section.title}</h3>
              )}
              <Separator className="flex-1" />
              {edit && (
                <Button variant="ghost" size="sm" onClick={() => edit.onAdd(section.id)}>
                  <Plus /> Widget
                </Button>
              )}
            </div>
          )}

          <ul
            aria-label={section.title ?? "Widgets"}
            className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
            // Dropping on the gap after the last widget appends to this section.
            onDragOver={(event) => edit && dragging && event.preventDefault()}
            onDrop={() => {
              if (!edit || !dragging) return;
              edit.onMove(dragging, { sectionId: section.id, beforeId: null });
              setDragging(null);
            }}
          >
            {section.widgets.map((widget) => (
              <Cell
                key={widget.id}
                workspaceId={workspaceId}
                widget={widget}
                sectionId={section.id}
                edit={edit}
                dragging={dragging}
                onDragState={setDragging}
              />
            ))}

            {section.widgets.length === 0 && (
              <li className="col-span-full list-none">
                <button
                  type="button"
                  onClick={() => edit?.onAdd(section.id)}
                  disabled={!edit}
                  className="flex h-28 w-full items-center justify-center gap-2 rounded-lg border border-dashed text-sm text-muted-foreground transition hover:border-primary/40 hover:text-foreground disabled:pointer-events-none"
                >
                  {edit ? (
                    <>
                      <Plus className="size-4" /> Add the first widget
                    </>
                  ) : (
                    "Nothing on this page yet"
                  )}
                </button>
              </li>
            )}
          </ul>
        </section>
      ))}
    </div>
  );
}
