import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, BridgeApiError, type Manifest, type RunDetail, type RunSummary } from "../api.js";
import { useWorkspaceId } from "../session.jsx";
import { Button, Card, EmptyState, ErrorText, Field, Input, Spinner } from "../ui.jsx";

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

export function AgentDetail() {
  const workspaceId = useWorkspaceId();
  const { agentId = "" } = useParams();
  const navigate = useNavigate();

  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [status, setStatus] = useState("draft");
  const [draft, setDraft] = useState("");
  const [runsList, setRunsList] = useState<RunSummary[]>([]);
  const [openRun, setOpenRun] = useState<RunDetail | null>(null);
  const [task, setTask] = useState("");
  const [instruction, setInstruction] = useState("");
  const [proposal, setProposal] = useState<Manifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<{ path: string; message: string }[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [{ agent }, { runs }] = await Promise.all([
      api.agent(workspaceId, agentId),
      api.runs(workspaceId, agentId),
    ]);
    setManifest(agent.manifest);
    setStatus(agent.status);
    setDraft(JSON.stringify(agent.manifest, null, 2));
    setRunsList(runs);
  }, [workspaceId, agentId]);

  useEffect(() => {
    void load();
  }, [load]);

  // While anything is in flight, poll so the user watches it progress.
  useEffect(() => {
    if (!runsList.some((run) => !TERMINAL.has(run.status))) return;
    const interval = setInterval(() => {
      void api.runs(workspaceId, agentId).then(({ runs }) => setRunsList(runs));
    }, 1500);
    return () => clearInterval(interval);
  }, [runsList, workspaceId, agentId]);

  const guard = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setIssues([]);
    setNotice(null);
    try {
      await action();
    } catch (err) {
      if (err instanceof BridgeApiError) {
        setError(err.error.message);
        setIssues(err.error.details ?? []);
      } else if (err instanceof SyntaxError) setError("That is not valid JSON.");
      else setError("Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  const save = (next: unknown) =>
    guard(async () => {
      const { agent } = await api.updateAgent(workspaceId, agentId, next);
      setManifest(agent.manifest);
      setDraft(JSON.stringify(agent.manifest, null, 2));
      setProposal(null);
      setNotice("Saved");
    });

  const startRun = (event: FormEvent) => {
    event.preventDefault();
    return guard(async () => {
      await api.startRun(workspaceId, agentId, task.trim());
      setTask("");
      const { runs } = await api.runs(workspaceId, agentId);
      setRunsList(runs);
    });
  };

  if (!manifest) return <Spinner label="Loading agent" />;

  const deployed = status === "deployed";

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">{manifest.meta.name}</h2>
          <p className="font-mono text-xs text-text-faint">
            {manifest.meta.slug} · {status}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            onClick={() =>
              guard(async () => {
                const { agent } = deployed
                  ? await api.stopAgent(workspaceId, agentId)
                  : await api.deployAgent(workspaceId, agentId);
                setStatus(agent.status);
              })
            }
            disabled={busy}
          >
            {deployed ? "Stop" : "Deploy"}
          </Button>
          <Button
            variant="danger"
            onClick={() =>
              guard(async () => {
                await api.deleteAgent(workspaceId, agentId);
                navigate("/agents");
              })
            }
          >
            Delete
          </Button>
        </div>
      </div>

      <ErrorText>{error}</ErrorText>
      {issues.length > 0 && (
        <ul className="flex flex-col gap-1 rounded-[var(--radius-sm)] border border-danger/40 bg-danger/5 p-3">
          {issues.map((issue) => (
            <li key={`${issue.path}:${issue.message}`} className="font-mono text-xs text-danger">
              {issue.path || "(root)"}: {issue.message}
            </li>
          ))}
        </ul>
      )}
      {notice && <p className="text-xs text-success">{notice}</p>}

      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <p className="text-xs text-text-muted">Runs on</p>
          <p className="text-sm font-medium">
            {manifest.deployment.target === "local"
              ? "This device"
              : manifest.deployment.target === "cloud"
                ? "Bridge Cloud"
                : "Self-hosted server"}
          </p>
        </Card>
        <Card>
          <p className="text-xs text-text-muted">Agents</p>
          <p className="text-sm font-medium">{manifest.agents.length}</p>
        </Card>
        <Card>
          <p className="text-xs text-text-muted">Background</p>
          <p className="text-sm font-medium">
            {manifest.deployment.background ? "Keeps running" : "Only while Bridge is open"}
          </p>
        </Card>
      </div>

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold">Give it a task</h3>
        <form onSubmit={startRun} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Field label="Task">
              {(id) => (
                <Input
                  id={id}
                  value={task}
                  onChange={(e) => setTask(e.target.value)}
                  placeholder="Summarize today's priorities"
                />
              )}
            </Field>
          </div>
          <Button type="submit" disabled={busy || !task.trim()}>
            Run
          </Button>
        </form>
        {!deployed && (
          <p className="text-xs text-text-muted">Deploy the agent before sending it work.</p>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold">Runs</h3>
        {runsList.length === 0 ? (
          <EmptyState title="No runs yet">Send the agent a task above.</EmptyState>
        ) : (
          <ul className="flex flex-col gap-2">
            {runsList.map((run) => (
              <li key={run.id}>
                <button
                  type="button"
                  onClick={() => guard(async () => setOpenRun(await api.run(workspaceId, run.id)))}
                  className="flex w-full items-center justify-between rounded-[var(--radius-md)] border border-border bg-bg-raised px-4 py-3 text-left transition hover:border-border-strong"
                >
                  <span className="flex flex-col">
                    <span className="font-mono text-xs text-text-faint">{run.id}</span>
                    <span className="text-xs text-text-muted">
                      {run.inputTokens + run.outputTokens} tokens
                      {run.costUsd ? ` · $${Number(run.costUsd).toFixed(4)}` : ""}
                    </span>
                  </span>
                  <span
                    className={`font-mono text-xs ${
                      run.status === "succeeded"
                        ? "text-success"
                        : run.status === "failed"
                          ? "text-danger"
                          : "text-text-muted"
                    }`}
                  >
                    {run.status}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {openRun && (
          <Card className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <p className="font-mono text-xs text-text-faint">{openRun.run.id}</p>
              <Button variant="ghost" onClick={() => setOpenRun(null)}>
                Close
              </Button>
            </div>
            {openRun.run.output?.content && (
              <p className="whitespace-pre-wrap text-sm">{openRun.run.output.content}</p>
            )}
            {openRun.run.error && <ErrorText>{openRun.run.error}</ErrorText>}
            <ol className="flex flex-col gap-2">
              {openRun.steps.map((step) => (
                <li
                  key={step.id}
                  className="rounded-[var(--radius-sm)] border border-border bg-bg p-3"
                >
                  <p className="font-mono text-[11px] text-text-muted">
                    {step.seq}. {step.type}
                    {step.agentName ? ` · ${step.agentName}` : ""}
                  </p>
                  <pre className="mt-1 overflow-x-auto font-mono text-[11px] text-text-faint">
                    {JSON.stringify(step.data, null, 2)}
                  </pre>
                </li>
              ))}
            </ol>
          </Card>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold">Change it in plain language</h3>
        <Card className="flex flex-col gap-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex-1">
              <Field
                label="Instruction"
                hint="Bridge proposes a change; nothing is saved until you accept it."
              >
                {(id) => (
                  <Input
                    id={id}
                    value={instruction}
                    onChange={(e) => setInstruction(e.target.value)}
                    placeholder="Add a research subagent and require approval before emails"
                  />
                )}
              </Field>
            </div>
            <Button
              variant="ghost"
              disabled={busy || !instruction.trim()}
              onClick={() =>
                guard(async () => {
                  const { manifest: next } = await api.editAgent(
                    workspaceId,
                    agentId,
                    instruction.trim(),
                  );
                  setProposal(next);
                })
              }
            >
              {busy ? "Thinking…" : "Propose"}
            </Button>
          </div>

          {proposal && (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-text-muted">Proposed manifest</p>
              <pre className="max-h-72 overflow-auto rounded-[var(--radius-sm)] border border-border bg-bg p-3 font-mono text-[11px]">
                {JSON.stringify(proposal, null, 2)}
              </pre>
              <div className="flex gap-2">
                <Button onClick={() => save(proposal)}>Accept and save</Button>
                <Button variant="ghost" onClick={() => setProposal(null)}>
                  Discard
                </Button>
              </div>
            </div>
          )}
        </Card>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Manifest</h3>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          className="h-96 w-full resize-y rounded-[var(--radius-md)] border border-border bg-bg-raised p-4 font-mono text-xs leading-relaxed text-text outline-none focus:border-border-strong"
        />
        <div>
          <Button onClick={() => save(JSON.parse(draft))} disabled={busy}>
            {busy ? "Saving…" : "Save manifest"}
          </Button>
        </div>
      </section>
    </div>
  );
}
