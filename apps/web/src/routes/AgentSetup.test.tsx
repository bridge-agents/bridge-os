import { parseManifest, personalAssistantTemplate } from "@bridge/spec";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Manifest } from "../api.js";
import { SessionProvider } from "../session.jsx";
import { AgentSetup } from "./AgentSetup.jsx";

/**
 * The setup form's one hard contract: whatever it hands back must be a
 * manifest the API will accept.
 *
 * Every other guarantee here is cosmetic by comparison — a mislabelled row is
 * an annoyance, but a form that silently produces an invalid manifest fails at
 * the moment someone presses Save, which is the worst possible time to find
 * out. So each test edits through the real controls and parses the result.
 */
const manifest = () => structuredClone(personalAssistantTemplate.manifest) as unknown as Manifest;

beforeEach(() => {
  // happy-dom ships no usable localStorage; the session provider reads one.
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  });

  // Signed out: the form must still render, falling back to the manifest's
  // own model rather than an empty list.
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(JSON.stringify({ error: { code: "unauthorized", message: "no" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function setup(onSave = vi.fn()) {
  render(
    <SessionProvider>
      <AgentSetup manifest={manifest()} busy={false} onSave={onSave} />
    </SessionProvider>,
  );
  return onSave;
}

describe("the agent setup form", () => {
  it("names every setting in words rather than schema paths", () => {
    setup();
    for (const label of [
      "What it should do",
      "Which model it thinks with",
      "What it can use",
      "What it may do on its own",
      "What it remembers",
      "When it runs by itself",
      "Limits",
      "What it can reach",
      "Where it runs",
    ]) {
      expect(screen.getByText(label), `no section called "${label}"`).toBeTruthy();
    }
    // Nothing on this screen should require reading JSON.
    expect(screen.queryByText(/specVersion/)).toBeNull();
  });

  it("shows the template's existing schedule in plain English", () => {
    setup();
    expect(screen.getByText("Every weekday at 07:00")).toBeTruthy();
  });

  it("saves nothing until asked", () => {
    const onSave = setup();
    fireEvent.click(screen.getByLabelText("Build a knowledge graph"));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("emits a valid manifest after a switch is flipped", () => {
    const onSave = setup();
    expect(manifest().memory.knowledge).toBe(false);

    fireEvent.click(screen.getByLabelText("Build a knowledge graph"));
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0]?.[0];
    expect(parseManifest(saved).memory.knowledge).toBe(true);
  });

  it("emits a valid manifest after a tool is switched off", () => {
    const onSave = setup();
    fireEvent.click(screen.getByLabelText("Web search"));
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    const saved = parseManifest(onSave.mock.calls[0]?.[0]);
    expect(saved.tools.map((tool) => tool.name)).not.toContain("web-search");
    /**
     * The schema rejects an agent that still lists a tool nobody granted, so
     * this passing is what proves the switch cleans up after itself.
     */
    expect(saved.agents.every((agent) => !agent.tools.includes("web-search"))).toBe(true);
  });

  it("emits a valid manifest after a limit is typed", () => {
    const onSave = setup();
    fireEvent.change(screen.getByLabelText("Daily spend limit in dollars"), {
      target: { value: "5" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    expect(parseManifest(onSave.mock.calls[0]?.[0]).runtime.limits.dailySpendUsd).toBe(5);
  });

  it("offers to discard, and puts the form back as it was", () => {
    const onSave = setup();
    fireEvent.click(screen.getByLabelText("Build a knowledge graph"));
    expect(screen.getByText("Unsaved changes")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /discard/i }));

    // No pending changes left to save, so the save bar goes away entirely.
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
  });
});
