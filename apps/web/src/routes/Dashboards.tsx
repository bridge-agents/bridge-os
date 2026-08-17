import { Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AgentArtwork } from "../AgentArtwork.jsx";
import {
  type AgentSummary,
  api,
  BridgeApiError,
  type Dashboard,
  type DashboardTemplateSummary,
  type Manifest,
} from "../api.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card.js";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select.js";
import { DashboardView } from "../dashboard/DashboardView.jsx";
import { NavArtwork } from "../NavArtwork.jsx";
import { useWorkspaceId } from "../session.jsx";
import { EmptyState, ErrorText, Field, Input, SectionHeader, Spinner } from "../ui.jsx";

export function Dashboards() {
  const workspaceId = useWorkspaceId();
  const [params, setParams] = useSearchParams();
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [templates, setTemplates] = useState<DashboardTemplateSummary[]>([]);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [workspaceDashboard, setWorkspaceDashboard] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [proposal, setProposal] = useState<Dashboard | null>(null);
  const target = params.get("agent") ?? "workspace";
  const agentId = target === "workspace" ? "" : target;

  useEffect(() => {
    void Promise.all([
      api.agents(workspaceId),
      api.dashboardTemplates(),
      api.workspaceDashboard(workspaceId),
    ]).then(([{ agents: list }, { templates: catalog }, { dashboard: savedDashboard }]) => {
      setAgents(list);
      setTemplates(catalog);
      setWorkspaceDashboard(savedDashboard);
    });
  }, [workspaceId]);

  const loadAgent = useCallback(async () => {
    if (!agentId) {
      setManifest(null);
      return;
    }
    const { agent } = await api.agent(workspaceId, agentId);
    setManifest(agent.manifest);
  }, [workspaceId, agentId]);

  useEffect(() => {
    void loadAgent();
  }, [loadAgent]);

  const dashboard = agentId
    ? ((manifest as { dashboard?: Dashboard } | null)?.dashboard ?? null)
    : workspaceDashboard;

  const save = async (next: Dashboard | undefined) => {
    setBusy(true);
    setError(null);
    try {
      if (agentId && manifest) {
        const updated = { ...manifest };
        if (next) updated.dashboard = next;
        else delete (updated as { dashboard?: unknown }).dashboard;
        await api.updateAgent(workspaceId, agentId, updated);
        await loadAgent();
      } else if (next) {
        const { dashboard: saved } = await api.updateWorkspaceDashboard(workspaceId, next);
        setWorkspaceDashboard(saved);
      } else {
        await api.deleteWorkspaceDashboard(workspaceId);
        setWorkspaceDashboard(null);
      }
      setProposal(null);
    } catch (cause) {
      setError(
        cause instanceof BridgeApiError ? cause.error.message : "Could not save that dashboard.",
      );
    } finally {
      setBusy(false);
    }
  };

  const describe = async () => {
    if (!instruction.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const models = (manifest as { models?: { default?: { provider?: string; model?: string } } })
        ?.models?.default;
      const designer = { provider: models?.provider, model: models?.model };
      const result = dashboard
        ? agentId
          ? await api.editDashboard(workspaceId, agentId, instruction.trim(), designer)
          : await api.editWorkspaceDashboard(workspaceId, dashboard, instruction.trim(), designer)
        : await api.draftDashboard(workspaceId, instruction.trim(), manifest?.meta?.name, designer);
      setProposal(result.dashboard);
    } catch (cause) {
      setError(
        cause instanceof BridgeApiError ? cause.error.message : "Could not design that dashboard.",
      );
    } finally {
      setBusy(false);
    }
  };

  if (!agents) return <Spinner label="Loading dashboards" />;

  return (
    <div className="flex w-full flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-3 shadow-sm">
        <span className="flex size-8 items-center justify-center rounded-lg bg-accent text-accent-foreground">
          <NavArtwork name="dashboard" className="size-5" />
        </span>
        <Select
          value={target}
          onValueChange={(value) => {
            setParams(value === "workspace" ? {} : { agent: value }, { replace: true });
            setProposal(null);
          }}
        >
          <SelectTrigger className="w-full sm:w-60" aria-label="Dashboard agent">
            <AgentArtwork className="size-4" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="start">
            <SelectGroup>
              <SelectLabel>Dashboard scope</SelectLabel>
              <SelectItem value="workspace">
                <NavArtwork name="dashboard" className="size-4" /> Workspace overview
              </SelectItem>
              {agents.map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  {agent.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <div className="min-w-0 flex-1 text-sm text-muted-foreground">
          {dashboard
            ? `${dashboard.name} · ${dashboard.pages.length} page${dashboard.pages.length === 1 ? "" : "s"}`
            : "No dashboard configured"}
        </div>
        {dashboard && !proposal && (
          <Button variant="outline" disabled={busy} onClick={() => void save(undefined)}>
            <Trash2 /> Remove
          </Button>
        )}
      </div>

      <ErrorText>{error}</ErrorText>

      {proposal && (
        <section className="space-y-4 rounded-lg border-2 border-amber-300 bg-amber-50/20 p-4 dark:border-amber-900 dark:bg-amber-950/10">
          <SectionHeader
            title="Dashboard proposal"
            description="Review the complete result before it replaces the saved dashboard."
            action={
              <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                Preview
              </Badge>
            }
          />
          <DashboardView workspaceId={workspaceId} dashboard={proposal} />
          <div className="flex gap-2">
            <Button disabled={busy} onClick={() => void save(proposal)}>
              Apply dashboard
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => setProposal(null)}>
              Discard
            </Button>
          </div>
        </section>
      )}

      {!proposal && dashboard && <DashboardView workspaceId={workspaceId} dashboard={dashboard} />}
      {!proposal && !dashboard && (
        <EmptyState title="No dashboard on this agent">
          Start from a template or describe the operational view you need.
        </EmptyState>
      )}

      <section className="space-y-4">
        <SectionHeader
          title={dashboard ? "Change dashboard" : "Design dashboard"}
          description={
            dashboard
              ? "Describe a change. Bridge returns a full preview before saving."
              : "Describe the signals and workflows this dashboard should surface."
          }
        />
        <Card className="rounded-lg">
          <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex-1">
              <Field label={dashboard ? "Change request" : "What do you need to see?"}>
                {(id) => (
                  <Input
                    id={id}
                    value={instruction}
                    onChange={(event) => setInstruction(event.target.value)}
                    placeholder={
                      dashboard
                        ? "Put spend and failures at the top"
                        : "Spend, failures, approvals, and active agents"
                    }
                  />
                )}
              </Field>
            </div>
            <Button disabled={busy || !instruction.trim()} onClick={() => void describe()}>
              <NavArtwork name="generating" className="size-4" />
              {busy ? "Designing" : dashboard ? "Propose change" : "Design dashboard"}
            </Button>
          </CardContent>
        </Card>
      </section>

      {!dashboard && (
        <section className="space-y-4">
          <SectionHeader
            title="Dashboard templates"
            description="Install a validated starting point and customize it later."
          />
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {templates.map((template) => (
              <Card key={template.id} className="rounded-lg">
                <CardHeader>
                  <CardTitle>{template.name}</CardTitle>
                  <CardDescription>{template.description}</CardDescription>
                  <CardAction>
                    <Badge variant="outline">{template.widgets} widgets</Badge>
                  </CardAction>
                </CardHeader>
                <CardContent>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => void save(template.dashboard)}
                  >
                    Use template
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
