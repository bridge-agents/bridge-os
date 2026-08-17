import { Cable, Check, CircleAlert, PlugZap, Radio, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type AgentSummary,
  api,
  BridgeApiError,
  type ChannelBinding,
  type ChannelConnector,
} from "../api.js";
import { ChannelLogo } from "../ChannelLogo.jsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../components/ui/alert-dialog.js";
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
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select.js";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table.js";
import { useSession, useWorkspaceId } from "../session.jsx";
import { ErrorText, Field, Input, SectionHeader, Spinner } from "../ui.jsx";

const STATUS_LABELS: Record<ChannelConnector["status"], string> = {
  available: "Available",
  "requires-webhook": "Webhook runtime",
  "requires-native-helper": "Native helper",
  planned: "Planned",
};

export function Channels() {
  const workspaceId = useWorkspaceId();
  const { workspace } = useSession();
  const [connectors, setConnectors] = useState<ChannelConnector[] | null>(null);
  const [bindings, setBindings] = useState<ChannelBinding[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [selected, setSelected] = useState<ChannelConnector | null>(null);
  const [agentId, setAgentId] = useState("");
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [removeBinding, setRemoveBinding] = useState<ChannelBinding | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canEdit = workspace?.role === "owner" || workspace?.role === "admin";

  const load = useCallback(async () => {
    try {
      const [{ connectors: catalog, bindings: configured }, { agents: agentList }] =
        await Promise.all([api.channels(workspaceId), api.agents(workspaceId)]);
      setConnectors(catalog);
      setBindings(configured);
      setAgents(agentList.filter((agent) => agent.status !== "archived"));
      setAgentId((current) => current || agentList[0]?.id || "");
      setError(null);
    } catch (cause) {
      setError(cause instanceof BridgeApiError ? cause.error.message : "Could not load channels.");
      setConnectors([]);
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const connectorByType = useMemo(
    () => new Map((connectors ?? []).map((connector) => [connector.type, connector])),
    [connectors],
  );

  const openConnect = (connector: ChannelConnector, existing?: ChannelBinding) => {
    setSelected(connector);
    setAgentId(existing?.agentId ?? agents[0]?.id ?? "");
    setCredentials({});
    setError(null);
  };

  const connect = async () => {
    if (!selected || !agentId) return;
    setBusy(true);
    setError(null);
    try {
      await api.connectChannel(workspaceId, selected.type, { agentId, credentials });
      setSelected(null);
      await load();
    } catch (cause) {
      setError(
        cause instanceof BridgeApiError ? cause.error.message : "Could not connect this channel.",
      );
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!removeBinding) return;
    setBusy(true);
    try {
      await api.disconnectChannel(workspaceId, removeBinding.type, removeBinding.agentId);
      setRemoveBinding(null);
      await load();
    } catch (cause) {
      setError(
        cause instanceof BridgeApiError ? cause.error.message : "Could not disconnect the channel.",
      );
    } finally {
      setBusy(false);
    }
  };

  if (!connectors) return <Spinner label="Loading channels" />;
  const activeCount = bindings.filter((binding) => binding.agentStatus === "deployed").length;

  return (
    <div className="flex w-full flex-col gap-7">
      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <CardContent className="flex items-center gap-3 py-1">
            <span className="flex size-9 items-center justify-center rounded-md bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
              <Radio />
            </span>
            <div>
              <p className="text-xl font-semibold">{activeCount}</p>
              <p className="text-xs text-muted-foreground">Active bindings</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-3 py-1">
            <span className="flex size-9 items-center justify-center rounded-md bg-accent text-accent-foreground">
              <Cable />
            </span>
            <div>
              <p className="text-xl font-semibold">{bindings.length}</p>
              <p className="text-xs text-muted-foreground">Configured bindings</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-3 py-1">
            <span className="flex size-9 items-center justify-center rounded-md bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300">
              <PlugZap />
            </span>
            <div>
              <p className="text-xl font-semibold">
                {connectors.filter((connector) => connector.status === "available").length}
              </p>
              <p className="text-xs text-muted-foreground">Installed adapters</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <ErrorText>{error}</ErrorText>

      <section className="space-y-4">
        <SectionHeader
          title="Connected channels"
          description="Bindings route incoming messages into the selected agent and send completed run output back to the same conversation."
        />
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Channel</TableHead>
                <TableHead>Agent</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-24 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {bindings.length ? (
                bindings.map((binding) => {
                  const connector = connectorByType.get(binding.type);
                  return (
                    <TableRow key={`${binding.agentId}:${binding.type}`}>
                      <TableCell>
                        <div className="flex items-center gap-2.5">
                          <ChannelLogo type={binding.type} className="size-7" />
                          <span className="font-medium">{connector?.name ?? binding.type}</span>
                        </div>
                      </TableCell>
                      <TableCell>{binding.agentName}</TableCell>
                      <TableCell>
                        <Badge variant={binding.agentStatus === "deployed" ? "default" : "outline"}>
                          {binding.agentStatus === "deployed" && <Check />}
                          {binding.agentStatus === "deployed" ? "Listening" : binding.agentStatus}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          {connector?.status === "available" && (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={!canEdit}
                              onClick={() => openConnect(connector, binding)}
                            >
                              Edit
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            disabled={!canEdit}
                            aria-label={`Disconnect ${connector?.name ?? binding.type} from ${binding.agentName}`}
                            onClick={() => setRemoveBinding(binding)}
                          >
                            <Trash2 />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              ) : (
                <TableRow>
                  <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                    No channel bindings configured.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </section>

      <section className="space-y-4">
        <SectionHeader
          title="Connector catalog"
          description="Installed adapters can be connected now. The remaining connectors show the runtime capability Bridge still needs."
        />
        <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
          {connectors.map((connector) => {
            const configured = bindings.filter((binding) => binding.type === connector.type).length;
            const available = connector.status === "available";
            return (
              <Card key={connector.type}>
                <CardHeader>
                  <ChannelLogo type={connector.type} className="mb-2" />
                  <CardTitle>{connector.name}</CardTitle>
                  <CardDescription>{connector.description}</CardDescription>
                  <CardAction>
                    <Badge variant={available ? "outline" : "secondary"}>
                      {available ? <Check /> : <CircleAlert />}
                      {STATUS_LABELS[connector.status]}
                    </Badge>
                  </CardAction>
                </CardHeader>
                <CardContent className="flex items-center justify-between gap-3">
                  <span className="text-xs text-muted-foreground">
                    {configured ? `${configured} configured` : "Not configured"}
                  </span>
                  <Button
                    size="sm"
                    variant={available ? "default" : "outline"}
                    disabled={!available || !canEdit || agents.length === 0}
                    onClick={() => openConnect(connector)}
                  >
                    <PlugZap /> {available ? "Connect" : "Runtime required"}
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </section>

      <Dialog open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {selected && <ChannelLogo type={selected.type} className="size-7" />}
              Connect {selected?.name}
            </DialogTitle>
            <DialogDescription>
              Credentials are encrypted. The agent starts listening when it is deployed.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <Field label="Agent">
              {(id) => (
                <Select value={agentId} onValueChange={setAgentId}>
                  <SelectTrigger id={id} className="w-full">
                    <SelectValue placeholder="Select an agent" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectLabel>Workspace agents</SelectLabel>
                      {agents.map((agent) => (
                        <SelectItem key={agent.id} value={agent.id}>
                          {agent.name}{" "}
                          <span className="text-muted-foreground">({agent.status})</span>
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              )}
            </Field>
            {selected?.fields.map((field) => (
              <Field key={field.key} label={field.label}>
                {(id) => (
                  <Input
                    id={id}
                    type="password"
                    value={credentials[field.key] ?? ""}
                    onChange={(event) =>
                      setCredentials((current) => ({ ...current, [field.key]: event.target.value }))
                    }
                    placeholder={field.placeholder}
                    autoComplete="off"
                  />
                )}
              </Field>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSelected(null)}>
              Cancel
            </Button>
            <Button
              disabled={
                busy ||
                !agentId ||
                Boolean(selected?.fields.some((field) => !credentials[field.key]))
              }
              onClick={() => void connect()}
            >
              <PlugZap /> {busy ? "Connecting" : "Connect"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={removeBinding !== null}
        onOpenChange={(open) => !open && setRemoveBinding(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect channel?</AlertDialogTitle>
            <AlertDialogDescription>
              Bridge will stop listening for this agent and delete the encrypted channel
              credentials.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={() => void disconnect()}
            >
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
