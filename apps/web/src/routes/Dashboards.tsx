import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  type AgentSummary,
  api,
  BridgeApiError,
  type Dashboard,
  type DashboardTemplateSummary,
  type Manifest,
} from "../api.js";
import { DashboardView } from "../dashboard/DashboardView.jsx";
import { useWorkspaceId } from "../session.jsx";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorText,
  Field,
  Input,
  SectionHeader,
  Select,
  Spinner,
} from "../ui.jsx";

/**
 * Dashboards belong to agents: a dashboard lives in the agent's manifest, so
 * it travels with the agent between deployment targets like everything else
 * (ADR-0008) rather than sitting in a table only this install knows about.
 *
 * Every change here — template, blank, or AI edit — is saved by PUTting the
 * manifest through the ordinary agent endpoint, so it passes exactly the
 * validation a hand-written change does.
 */
export function Dashboards() {
  const workspaceId = useWorkspaceId();
  const [params, setParams] = useSearchParams();

  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [templates, setTemplates] = useState<DashboardTemplateSummary[]>([]);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // AI editing: a proposal is previewed, never applied behind your back.
  const [instruction, setInstruction] = useState("");
  const [proposal, setProposal] = useState<Dashboard | null>(null);

  const [fallbackAgentId, setFallbackAgentId] = useState("");
  const agentId = params.get("agent") ?? fallbackAgentId;

  useEffect(() => {
    void Promise.all([api.agents(workspaceId), api.dashboardTemplates()]).then(
      ([{ agents: list }, { templates: catalog }]) => {
        setAgents(list);
        setTemplates(catalog);
        setFallbackAgentId(list[0]?.id ?? "");
      },
    );
  }, [workspaceId]);

  const loadAgent = useCallback(async () => {
    if (!agentId) return setManifest(null);
    const { agent } = await api.agent(workspaceId, agentId);
    setManifest(agent.manifest);
  }, [workspaceId, agentId]);

  useEffect(() => {
    void loadAgent();
  }, [loadAgent]);

  const dashboard = (manifest as { dashboard?: Dashboard } | null)?.dashboard ?? null;

  /** Save a dashboard onto the agent's manifest. */
  const save = async (next: Dashboard | undefined) => {
    if (!manifest || !agentId) return;
    setBusy(true);
    setError(null);
    try {
      const updated = { ...manifest };
      if (next) updated.dashboard = next;
      else delete (updated as { dashboard?: unknown }).dashboard;

      await api.updateAgent(workspaceId, agentId, updated);
      setProposal(null);
      await loadAgent();
    } catch (err) {
      setError(err instanceof BridgeApiError ? err.error.message : "Could not save that.");
    } finally {
      setBusy(false);
    }
  };

  const describe = async () => {
    if (!instruction.trim() || !agentId) return;
    setBusy(true);
    setError(null);
    try {
      // Design with the agent's own model, so a local provider Bridge has no
      // default for still works.
      const models = (manifest as { models?: { default?: { provider?: string; model?: string } } })
        ?.models?.default;
      const designer = { provider: models?.provider, model: models?.model };

      const result = dashboard
        ? await api.editDashboard(workspaceId, agentId, instruction.trim(), designer)
        : await api.draftDashboard(workspaceId, instruction.trim(), manifest?.meta?.name, designer);
      setProposal(result.dashboard);
    } catch (err) {
      setError(err instanceof BridgeApiError ? err.error.message : "Could not design that.");
    } finally {
      setBusy(false);
    }
  };

  if (!agents) return <Spinner label="Loading dashboards" />;

  if (agents.length === 0) {
    return (
      <EmptyState title="No agents yet">
        Dashboards belong to an agent. Create one on the Agents page first.
      </EmptyState>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <label
          htmlFor="dashboard-agent"
          className="font-condensed text-[11px] font-semibold uppercase tracking-[0.1em] text-text-muted"
        >
          Agent
        </label>
        <Select
          id="dashboard-agent"
          value={agentId}
          onChange={(e) => {
            setParams({ agent: e.target.value }, { replace: true });
            setProposal(null);
          }}
        >
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </Select>
        <div className="flex-1" />
        {dashboard && !proposal && (
          <Button variant="quiet" disabled={busy} onClick={() => save(undefined)}>
            Remove dashboard
          </Button>
        )}
      </div>

      <ErrorText>{error}</ErrorText>

      {/* A proposal is shown in full before it replaces anything. */}
      {proposal && (
        <div className="flex flex-col gap-3">
          <SectionHeader
            title="Proposed"
            description="This is what the change would look like. Nothing is saved until you apply it."
            action={<Badge tone="warning">preview</Badge>}
          />
          <div className="rounded-[var(--radius-md)] border border-warning/40 p-3">
            <DashboardView workspaceId={workspaceId} dashboard={proposal} />
          </div>
          <div className="flex gap-2">
            <Button disabled={busy} onClick={() => save(proposal)}>
              Apply
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setProposal(null)}>
              Discard
            </Button>
          </div>
        </div>
      )}

      {!proposal && dashboard && <DashboardView workspaceId={workspaceId} dashboard={dashboard} />}

      {!proposal && !dashboard && (
        <EmptyState title="No dashboard on this agent">
          Start from a template below, or describe what you want to see.
        </EmptyState>
      )}

      <section className="flex flex-col gap-3">
        <SectionHeader
          title={dashboard ? "Change it" : "Describe it"}
          description={
            dashboard
              ? "Say what to change in plain language — “put spend at the top”. You review the result before it replaces anything."
              : "Describe what you want to see and Bridge designs it against the data this workspace actually has."
          }
        />
        <Card className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Field label={dashboard ? "Change" : "What do you want to see?"}>
              {(id) => (
                <Input
                  id={id}
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  placeholder={
                    dashboard
                      ? "Put my agent costs at the top"
                      : "Spend, failures and what is running"
                  }
                />
              )}
            </Field>
          </div>
          <Button disabled={busy || !instruction.trim()} onClick={describe}>
            {busy ? "Designing…" : dashboard ? "Propose change" : "Design it"}
          </Button>
        </Card>
      </section>

      {!dashboard && (
        <section className="flex flex-col gap-3">
          <SectionHeader title="Or start from a template" />
          <div className="grid gap-2 sm:grid-cols-2">
            {templates.map((template) => (
              <button
                key={template.id}
                type="button"
                disabled={busy}
                onClick={() => save(template.dashboard)}
                className="flex flex-col gap-1 rounded-[var(--radius-sm)] border border-border bg-bg-raised p-3 text-left transition hover:border-border-strong hover:bg-bg-overlay disabled:opacity-50"
              >
                <span className="font-condensed text-sm font-semibold uppercase tracking-[0.06em]">
                  {template.name}
                </span>
                <span className="text-xs text-text-muted">{template.description}</span>
                <span className="mt-1 font-mono text-[10px] text-text-faint">
                  {template.widgets} widgets
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
