import { Plus, Search } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  type AgentSummary,
  api,
  BridgeApiError,
  type KnowledgeEdge,
  type KnowledgeNode,
} from "../api.js";
import { Button } from "../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../components/ui/dialog.js";
import { Input } from "../components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select.js";
import { Textarea } from "../components/ui/textarea.js";
import { useSession, useWorkspaceId } from "../session.jsx";
import { ErrorText, Field, SectionHeader, Spinner } from "../ui.jsx";
import { KnowledgeGraphView } from "./KnowledgeGraphView.jsx";

export function Knowledge() {
  const workspaceId = useWorkspaceId();
  const { workspace } = useSession();
  const canAdmin = workspace?.role === "owner" || workspace?.role === "admin";
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [graph, setGraph] = useState<{ nodes: KnowledgeNode[]; edges: KnowledgeEdge[] } | null>(
    null,
  );
  const [query, setQuery] = useState("");
  const [agentFilter, setAgentFilter] = useState("all");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [agentId, setAgentId] = useState("");
  const [kind, setKind] = useState<"knowledge" | "long-term">("knowledge");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [{ agents: agentList }, known] = await Promise.all([
      api.agents(workspaceId),
      api.knowledgeGraph(workspaceId, agentFilter !== "all" ? agentFilter : undefined),
    ]);
    setAgents(agentList);
    setGraph(known);
    setAgentId((current) => current || agentList[0]?.id || "");
  }, [workspaceId, agentFilter]);

  /**
   * Searching hides points rather than refetching: the graph is small enough
   * to hold, and keeping the layout still while you type is the difference
   * between filtering a map and being handed a new one each keystroke.
   */
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle || !graph) return graph?.nodes ?? [];
    return graph.nodes.filter(
      (node) =>
        node.title.toLowerCase().includes(needle) || node.body.toLowerCase().includes(needle),
    );
  }, [graph, query]);

  useEffect(() => {
    const timeout = setTimeout(
      () => void load().catch(() => setError("Could not load durable knowledge.")),
      query ? 250 : 0,
    );
    return () => clearTimeout(timeout);
  }, [load, query]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!agentId || !content.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.createMemory(workspaceId, { agentId, kind, content: content.trim() });
      setContent("");
      setDialogOpen(false);
      await load();
    } catch (cause) {
      setError(
        cause instanceof BridgeApiError ? cause.error.message : "Could not save this knowledge.",
      );
    } finally {
      setBusy(false);
    }
  };

  if (!graph) return <Spinner label="Loading knowledge" />;

  return (
    <div className="flex w-full flex-col gap-6">
      <SectionHeader
        title="Knowledge"
        description="What your agents have come to know, and how it connects. Gathered from conversations in the background, not after every message."
        action={
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button disabled={!canAdmin || agents.length === 0}>
                <Plus /> Add knowledge
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add durable knowledge</DialogTitle>
                <DialogDescription>
                  Save verified context for one agent. It remains available across conversations.
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={create} className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Agent">
                    {() => (
                      <Select value={agentId} onValueChange={setAgentId}>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Select agent" />
                        </SelectTrigger>
                        <SelectContent>
                          {agents.map((agent) => (
                            <SelectItem key={agent.id} value={agent.id}>
                              {agent.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </Field>
                  <Field label="Memory type">
                    {() => (
                      <Select value={kind} onValueChange={(value) => setKind(value as typeof kind)}>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="knowledge">Curated knowledge</SelectItem>
                          <SelectItem value="long-term">Long-term memory</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                  </Field>
                </div>
                <Field label="Content" hint={`${content.length}/20000`}>
                  {(id) => (
                    <Textarea
                      id={id}
                      value={content}
                      onChange={(event) => setContent(event.target.value)}
                      rows={8}
                      maxLength={20_000}
                      placeholder="Add a policy, fact, preference, or operating procedure."
                    />
                  )}
                </Field>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={busy || !agentId || !content.trim()}>
                    {busy ? "Saving" : "Save knowledge"}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        }
      />

      <div className="flex flex-col gap-2 rounded-lg border bg-card p-3 sm:flex-row sm:items-center">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="pl-8"
            placeholder="Search durable knowledge"
            aria-label="Search knowledge"
          />
        </div>
        <Select value={agentFilter} onValueChange={setAgentFilter}>
          <SelectTrigger className="w-full sm:w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All agents</SelectItem>
            {agents.map((agent) => (
              <SelectItem key={agent.id} value={agent.id}>
                {agent.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <ErrorText>{error}</ErrorText>
      <KnowledgeGraphView
        nodes={visible}
        edges={graph?.edges ?? []}
        canAdmin={canAdmin}
        onForget={(nodeId) =>
          void api
            .forgetKnowledge(workspaceId, nodeId)
            .then(load)
            .catch((cause) =>
              setError(
                cause instanceof BridgeApiError ? cause.error.message : "Could not forget that.",
              ),
            )
        }
      />
    </div>
  );
}
