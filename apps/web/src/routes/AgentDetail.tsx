import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, BridgeApiError, type Manifest } from "../api.js";
import { useWorkspaceId } from "../session.jsx";
import { Button, Card, ErrorText, Spinner } from "../ui.jsx";

/**
 * Phase 2 shows the manifest as editable JSON: it is the real source of
 * truth, and the structured editor (Phase 3) will edit exactly this object.
 */
export function AgentDetail() {
  const workspaceId = useWorkspaceId();
  const { agentId = "" } = useParams();
  const navigate = useNavigate();

  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<{ path: string; message: string }[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { agent } = await api.agent(workspaceId, agentId);
    setManifest(agent.manifest);
    setDraft(JSON.stringify(agent.manifest, null, 2));
  }, [workspaceId, agentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setBusy(true);
    setError(null);
    setIssues([]);
    setStatus(null);
    try {
      const parsed = JSON.parse(draft) as unknown;
      const { agent } = await api.updateAgent(workspaceId, agentId, parsed);
      setManifest(agent.manifest);
      setDraft(JSON.stringify(agent.manifest, null, 2));
      setStatus("Saved");
    } catch (err) {
      if (err instanceof SyntaxError) setError("That is not valid JSON.");
      else if (err instanceof BridgeApiError) {
        setError(err.error.message);
        setIssues(err.error.details ?? []);
      } else setError("Could not save the manifest.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    await api.deleteAgent(workspaceId, agentId);
    navigate("/agents");
  };

  if (!manifest) return <Spinner label="Loading agent" />;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">{manifest.meta.name}</h2>
          <p className="font-mono text-xs text-text-faint">{manifest.meta.slug}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="danger" onClick={remove}>
            Delete
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save manifest"}
          </Button>
        </div>
      </div>

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

      <div className="flex flex-col gap-2">
        <p className="text-sm font-semibold">Manifest</p>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          className="h-[28rem] w-full resize-y rounded-[var(--radius-md)] border border-border bg-bg-raised p-4 font-mono text-xs leading-relaxed text-text outline-none focus:border-border-strong"
        />
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
        {status && <p className="text-xs text-success">{status}</p>}
      </div>
    </div>
  );
}
