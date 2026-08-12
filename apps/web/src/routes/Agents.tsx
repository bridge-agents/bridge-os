import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { type AgentSummary, api, BridgeApiError, type TemplateSummary } from "../api.js";
import { useWorkspaceId } from "../session.jsx";
import { Button, Card, EmptyState, ErrorText, Field, Input, Spinner } from "../ui.jsx";

export function Agents() {
  const workspaceId = useWorkspaceId();
  const navigate = useNavigate();
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [name, setName] = useState("");
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

  const create = async (body: { templateId?: string; name?: string }) => {
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
          <ErrorText>{error}</ErrorText>

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
