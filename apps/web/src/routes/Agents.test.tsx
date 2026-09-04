import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RouteErrorBoundary } from "../RouteError.jsx";
import { Agents } from "./Agents.jsx";

/**
 * What the page does when the server is not this build's server.
 *
 * A desktop install updates its window and its API separately, and a dev
 * server outlives many API restarts, so a response missing newer fields is an
 * ordinary event rather than an exotic one. It used to throw partway through a
 * render, which unmounts everything — the user got a blank window with no
 * sidebar and no clue which page had failed.
 */
const OLD_TEMPLATE = {
  id: "personal-assistant",
  name: "Personal Assistant",
  description: "A day-to-day assistant.",
  category: "personal",
  agents: 2,
  tools: ["web-search", "filesystem"],
  // No icon, color, setup, or schedules — the shape before this version.
};

const OLD_AGENT = {
  id: "agt_1",
  name: "Existing",
  slug: "existing",
  status: "deployed",
  specVersion: 1,
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function serve(templates: unknown[], agents: unknown[]) {
  vi.stubGlobal("fetch", async (url: string | URL) => {
    const body = String(url).includes("/templates") ? { templates } : { agents };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

vi.mock("../session.jsx", async (original) => ({
  ...((await original()) as object),
  useWorkspaceId: () => "ws_test",
}));

describe("the agents page against an older API", () => {
  it("renders templates that arrive without the newer fields", async () => {
    serve([OLD_TEMPLATE], []);
    render(
      <MemoryRouter>
        <Agents />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Personal Assistant")).toBeTruthy();
    // The optional extras simply do not appear; nothing throws.
    expect(screen.queryByText(/connecting first/)).toBeNull();
  });

  it("renders agents that arrive without an icon", async () => {
    serve([], [OLD_AGENT]);
    render(
      <MemoryRouter>
        <Agents />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Existing")).toBeTruthy();
  });
});

describe("the route error boundary", () => {
  const Boom = () => {
    throw new Error("render exploded");
  };

  it("shows the failure without unmounting everything around it", () => {
    // React logs the caught error; the test asserts on what the user sees.
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <div>
        <nav>Sidebar</nav>
        <RouteErrorBoundary resetKey="/agents">
          <Boom />
        </RouteErrorBoundary>
      </div>,
    );

    expect(screen.getByText("Sidebar")).toBeTruthy();
    expect(screen.getByText("This page could not be shown")).toBeTruthy();
    expect(screen.getByText("render exploded")).toBeTruthy();
    quiet.mockRestore();
  });

  /** A stuck error surviving navigation would trap the user on a dead page. */
  it("clears when the route changes", () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const { rerender } = render(
      <RouteErrorBoundary resetKey="/agents">
        <Boom />
      </RouteErrorBoundary>,
    );
    expect(screen.getByText("This page could not be shown")).toBeTruthy();

    rerender(
      <RouteErrorBoundary resetKey="/chat">
        <p>Chat works</p>
      </RouteErrorBoundary>,
    );

    expect(screen.getByText("Chat works")).toBeTruthy();
    expect(screen.queryByText("This page could not be shown")).toBeNull();
    quiet.mockRestore();
  });
});
