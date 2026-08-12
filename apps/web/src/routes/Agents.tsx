import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  type AgentSummary,
  api,
  BridgeApiError,
  type Manifest,
  type TemplateSummary,
} from "../api.js";
import { useWorkspaceId } from "../session.jsx";
import { Button, Card, EmptyState, ErrorText, Field, Input, Spinner } from "../ui.jsx";

export function Agents() {
  const workspaceId = useWorkspaceId();
  const navigate = useNavigate();
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [proposal, setProposal] = useState<Manifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [{ agents: list }, { templates: catalog }] = await Promise.all([
      api.agents(workspaceId),
      api.templates(),
    ]);
    setAgents(list);
    setTemplates(catalog);
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (body: { templateId?: string; name?: string; manifest?: unknown }) => {
    setBusy(true);
    setError(null);
    try {
      const { agent } = await api.createAgent(workspaceId, {
        ...body,
        name: body.name ?? name.trim() ?? undefined,
      });
      navigate(`/agents/${agent.id}`);
    } catch (err) {
      setError(err instanceof BridgeApiError ? err.error.message : "Could not create the agent.");
    } finally {
      setBusy(false);
    }
  };

  if (!agents) return <Spinner label="Loading agents" />;

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <div>
          <h2 className="text-sm font-semibold">Create an agent</h2>
          <p className="text-sm text-text-muted">
            Start from a template or describe your own. Either way you get the same Bridge manifest,
            which you can edit afterwards.
          </p>
        </div>

        <Card className="flex flex-col gap-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex-1">
              <Field label="Name">
                {(id) => (
                  <Input
                    id={id}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="My Assistant"
                  />
                )}
              </Field>
            </div>
            <Button onClick={() => create({})} disabled={busy || name.trim().length === 0}>
              Start blank
            </Button>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex-1">
              <Field
                label="Or describe what you want"
                hint="Bridge designs the agent, then you review it before it is created."
              >
                {(id) => (
                  <Input
                    id={id}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Watch my inbox and draft replies, but never send without asking"
                  />
                )}
              </Field>
            </div>
            <Button
              variant="ghost"
              disabled={busy || description.trim().length === 0}
              onClick={() =>
                void (async () => {
                  setBusy(true);
                  setError(null);
                  try {
                    const { manifest } = await api.draftAgent(
                      workspaceId,
                      description.trim(),
                      name.trim() || undefined,
                    );
                    setProposal(manifest);
                  } catch (err) {
                    setError(
                      err instanceof BridgeApiError ? err.error.message : "Could not design that.",
                    );
                  } finally {
                    setBusy(false);
                  }
                })()
              }
            >
              {busy ? "Designing…" : "Design it"}
            </Button>
          </div>
          <ErrorText>{error}</ErrorText>

          {proposal && (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-text-muted">
                Proposed design — {proposal.agents.length} agent
                {proposal.agents.length === 1 ? "" : "s"}
              </p>
              <pre className="max-h-72 overflow-auto rounded-[var(--radius-sm)] border border-border bg-bg p-3 font-mono text-[11px]">
                {JSON.stringify(proposal, null, 2)}
              </pre>
              <div className="flex gap-2">
                <Button onClick={() => create({ manifest: proposal })}>Create this agent</Button>
                <Button variant="ghost" onClick={() => setProposal(null)}>
                  Discard
                </Button>
              </div>
            </div>
          )}

          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {templates.map((template) => (
              <button
                key={template.id}
                type="button"
                disabled={busy}
                onClick={() => create({ templateId: template.id })}
                className="flex flex-col gap-1 rounded-[var(--radius-sm)] border border-border bg-bg p-3 text-left transition hover:border-border-strong disabled:opacity-50"
              >
                <span className="text-sm font-medium">{template.name}</span>
                <span className="text-xs text-text-muted">{template.description}</span>
                <span className="mt-1 font-mono text-[10px] text-text-faint">
                  {template.agents} agent{template.agents === 1 ? "" : "s"}
                  {template.tools.length > 0 && ` · ${template.tools.join(", ")}`}
                </span>
              </button>
            ))}
          </div>
        </Card>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">Your agents</h2>
        {agents.length === 0 ? (
          <EmptyState title="No agents yet">Create one above to get started.</EmptyState>
        ) : (
          <ul className="flex flex-col gap-2">
            {agents.map((agent) => (
              <li key={agent.id}>
                <Link
                  to={`/agents/${agent.id}`}
                  className="flex items-center justify-between rounded-[var(--radius-md)] border border-border bg-bg-raised px-4 py-3 transition hover:border-border-strong"
                >
                  <span className="flex flex-col">
                    <span className="text-sm font-medium">{agent.name}</span>
                    <span className="font-mono text-xs text-text-faint">{agent.slug}</span>
                  </span>
                  <span className="font-mono text-xs text-text-muted">{agent.status}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
