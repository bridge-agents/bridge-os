import { Blocks, Check, CircleAlert, Plus } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { api, BridgeApiError, type Manifest } from "../api.js";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select.js";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs.js";
import { useSession } from "../session.jsx";
import { ToolIcon } from "../ToolIcon.jsx";
import {
  grantedTools,
  TOOL_CATALOG,
  TOOL_CATEGORIES,
  type ToolCatalogEntry,
  toolSecretName,
  withTool,
} from "../toolCatalog.js";
import { ErrorText, Field, Input, SectionHeader } from "../ui.jsx";

interface AgentRow {
  id: string;
  name: string;
  manifest?: Manifest;
}

export function ToolSettings() {
  const { workspace } = useSession();
  const canAdmin = workspace?.role === "owner" || workspace?.role === "admin";
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [category, setCategory] = useState<string>("Built in");
  const [selected, setSelected] = useState<ToolCatalogEntry | null>(null);
  const [agentId, setAgentId] = useState("");
  const [credential, setCredential] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!workspace) return;
    const { agents: list } = await api.agents(workspace.id);
    const detailed = await Promise.all(
      list.map(async (agent) => {
        const { agent: full } = await api.agent(workspace.id, agent.id).catch(() => ({
          agent: undefined as unknown as { manifest: Manifest },
        }));
        return { id: agent.id, name: agent.name, manifest: full?.manifest };
      }),
    );
    setAgents(detailed);
    setAgentId((current) => current || (detailed[0]?.id ?? ""));
  }, [workspace]);

  useEffect(() => {
    void load().catch(() => setError("Could not load your agents."));
  }, [load]);

  const usedBy = (entry: ToolCatalogEntry) =>
    agents.filter((agent) => grantedTools(agent.manifest).includes(entry.id));

  const open = (entry: ToolCatalogEntry) => {
    setSelected(entry);
    setCredential("");
    setError(null);
  };

  const install = async (event: FormEvent) => {
    event.preventDefault();
    if (!workspace || !selected) return;
    const agent = agents.find((one) => one.id === agentId);
    if (!agent?.manifest) {
      setError("Pick an agent to add this to.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      let secretName: string | undefined;
      if (selected.credential && credential.trim()) {
        secretName = toolSecretName(selected.id);
        await api.putSecret(workspace.id, secretName, `Bearer ${credential.trim()}`);
      }
      await api.updateAgent(workspace.id, agent.id, withTool(agent.manifest, selected, secretName));
      await load();
      setSelected(null);
    } catch (cause) {
      setError(cause instanceof BridgeApiError ? cause.error.message : "Could not add that tool.");
    } finally {
      setBusy(false);
    }
  };

  const shown = TOOL_CATALOG.filter((entry) => entry.category === category);

  return (
    <section id="tools" className="scroll-mt-20 space-y-4">
      <SectionHeader
        title="Tools"
        description="What your agents can do. Built-in tools need only be switched on; connectors reach a service on your behalf and need a token."
        action={<Blocks className="size-7 text-muted-foreground" />}
      />

      <Tabs value={category} onValueChange={setCategory}>
        <TabsList size="comfortable" className="max-w-full justify-start overflow-x-auto">
          {TOOL_CATEGORIES.map((name) => (
            <TabsTrigger key={name} value={name}>
              {name}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
        {shown.map((entry) => {
          const on = usedBy(entry);
          const available = !entry.unavailable;
          return (
            <Card key={entry.id}>
              <CardHeader>
                <ToolIcon tool={entry.id} className="mb-1 size-9" />
                <CardTitle>{entry.name}</CardTitle>
                <CardDescription>{entry.description}</CardDescription>
                <CardAction>
                  <Badge variant={on.length ? "default" : available ? "outline" : "secondary"}>
                    {on.length ? <Check /> : available ? null : <CircleAlert />}
                    {on.length ? `On for ${on.length}` : available ? "Available" : "Not yet"}
                  </Badge>
                </CardAction>
              </CardHeader>
              <CardContent className="flex items-end justify-between gap-3">
                <span className="text-xs text-muted-foreground">
                  {on.length
                    ? on.map((agent) => agent.name).join(", ")
                    : (entry.unavailable ?? "Not added to any agent")}
                </span>
                <Button
                  size="sm"
                  variant={available ? "default" : "outline"}
                  disabled={!available || !canAdmin || agents.length === 0}
                  onClick={() => open(entry)}
                >
                  <Plus /> Add
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Dialog open={selected !== null} onOpenChange={(next) => !next && setSelected(null)}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={install}>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                {selected && <ToolIcon tool={selected.id} className="size-7" />}
                Add {selected?.name}
              </DialogTitle>
              <DialogDescription>
                {selected?.kind === "native"
                  ? "Switches this tool on for the agent. Anything destructive still asks before it runs."
                  : "The token is encrypted and only ever read by the runtime, for one call at a time."}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <Field label="Agent">
                {(id) => (
                  <Select value={agentId} onValueChange={setAgentId}>
                    <SelectTrigger id={id} className="w-full">
                      <SelectValue placeholder="Select an agent" />
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
              {selected?.credential && (
                <Field label={selected.credential.label} hint={selected.credential.hint}>
                  {(id) => (
                    <Input
                      id={id}
                      type="password"
                      value={credential}
                      onChange={(event) => setCredential(event.target.value)}
                      required
                    />
                  )}
                </Field>
              )}
              <ErrorText>{error}</ErrorText>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setSelected(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? "Adding…" : "Add to agent"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
