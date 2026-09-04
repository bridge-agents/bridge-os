import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Dashboard } from "../api.js";
import { DashboardView } from "./DashboardView.jsx";

/**
 * The grid's own behaviour, as opposed to the document edits it requests.
 *
 * Chiefly: a drop must be handled once. The section behind every cell also
 * accepts drops so that aiming at empty space appends, and when that handler
 * was allowed to run after the cell's, a widget dragged onto its neighbour
 * quietly jumped to the end of the section instead.
 */
const dashboard: Dashboard = {
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
          title: "At a glance",
          widgets: [
            { id: "a", type: "text", title: "A", content: "a" },
            { id: "b", type: "text", title: "B", content: "b" },
            { id: "c", type: "text", title: "C", content: "c" },
          ],
        },
      ],
    },
  ],
};

const handlers = () => ({
  onMove: vi.fn(),
  onShift: vi.fn(),
  onResize: vi.fn(),
  onEdit: vi.fn(),
  onDuplicate: vi.fn(),
  onRemove: vi.fn(),
  onAdd: vi.fn(),
});

function draw(edit?: ReturnType<typeof handlers>) {
  render(
    <MemoryRouter>
      <DashboardView workspaceId="ws" dashboard={dashboard} edit={edit} />
    </MemoryRouter>,
  );
}

const cells = () => Array.from(document.querySelectorAll("li[data-widget]"));
const draggableCells = () => cells().filter((cell) => (cell as HTMLElement).draggable);

beforeEach(() => {
  vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("dragging a widget", () => {
  it("asks to place it before the widget it was dropped on, exactly once", () => {
    const edit = handlers();
    draw(edit);

    const [first, , third] = cells();
    if (!first || !third) throw new Error("expected three cells");

    fireEvent.dragStart(third);
    fireEvent.dragOver(first);
    fireEvent.drop(first);

    expect(edit.onMove).toHaveBeenCalledTimes(1);
    expect(edit.onMove).toHaveBeenCalledWith("c", { sectionId: "top", beforeId: "a" });
  });

  it("appends when the drop lands on the section rather than a widget", () => {
    const edit = handlers();
    draw(edit);

    const [first] = cells();
    const section = screen.getByRole("list", { name: "At a glance" });
    if (!first) throw new Error("expected a cell");

    fireEvent.dragStart(first);
    fireEvent.drop(section);

    expect(edit.onMove).toHaveBeenCalledWith("a", { sectionId: "top", beforeId: null });
  });
});

describe("outside edit mode", () => {
  it("shows the widgets without any handles", () => {
    draw();
    expect(screen.getByText("A")).toBeTruthy();
    expect(cells()).toHaveLength(3);
    expect(draggableCells()).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /Resize/ })).toBeNull();
  });
});

describe("resizing", () => {
  it("is reachable from the keyboard, not only by dragging", () => {
    const edit = handlers();
    draw(edit);

    const handle = screen.getAllByRole("button", { name: /^Resize/ })[0];
    if (!handle) throw new Error("expected a resize handle");

    // "A" is a text widget: one column naturally, so right is 2 and left holds
    // at 1 rather than writing a zero span the schema would reject.
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(edit.onResize).toHaveBeenCalledWith("a", 2);

    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(edit.onResize).toHaveBeenCalledWith("a", 1);
  });
});
