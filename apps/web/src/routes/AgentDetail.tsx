import {
  Braces,
  Cloud,
  History,
  Laptop,
  Loader2,
  MessageSquareText,
  Play,
  Save,
  Server,
  Square,
  Trash2,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { AgentArtwork } from "../AgentArtwork.jsx";
import { api, BridgeApiError, type Manifest, type RunDetail, type RunSummary } from "../api.js";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
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
import { Separator } from "../components/ui/separator.js";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../components/ui/sheet.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs.js";
import { Textarea } from "../components/ui/textarea.js";
import { NavArtwork } from "../NavArtwork.jsx";
import { useWorkspaceId } from "../session.jsx";
import { EmptyState, ErrorText, Field, Input, Spinner } from "../ui.jsx";

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "limit_reached", "refused"]);

const statusStyle = (status: string) => {
  if (status === "succeeded" || status === "deployed")
    return "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300";
  if (status === "failed" || status === "cancelled") return "bg-destructive/10 text-destructive";
  if (status === "running" || status === "queued")
    return "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300";
  return "bg-secondary text-secondary-foreground";
};

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
    } catch (cause) {
      if (cause instanceof BridgeApiError) {
        setError(cause.error.message);
        setIssues(cause.error.details ?? []);
      } else if (cause instanceof SyntaxError) setError("That is not valid JSON.");
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
      setNotice("Agent configuration saved.");
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
  const DeploymentIcon =
    manifest.deployment.target === "local"
      ? Laptop
      : manifest.deployment.target === "cloud"
        ? Cloud
        : Server;

  return (
    <div className="flex w-full flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <AgentArtwork group={manifest.agents.length > 1} className="size-11" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-xl font-semibold">{manifest.meta.name}</h2>
              <Badge variant="outline" className={statusStyle(status)}>
                {status}
              </Badge>
            </div>
            <p className="truncate font-mono text-xs text-muted-foreground">{manifest.meta.slug}</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {deployed && (
            <Button variant="outline" onClick={() => navigate(`/chat?agent=${agentId}`)}>
              <MessageSquareText /> Open chat
            </Button>
          )}
          <Button
            variant={deployed ? "outline" : "default"}
            onClick={() =>
              void guard(async () => {
                const { agent } = deployed
                  ? await api.stopAgent(workspaceId, agentId)
                  : await api.deployAgent(workspaceId, agentId);
                setStatus(agent.status);
              })
            }
            disabled={busy}
          >
            {deployed ? <Square /> : <Play />}
            {deployed ? "Stop" : "Deploy"}
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive">
                <Trash2 /> Delete
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete {manifest.meta.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  This removes the agent, its manifest, and access to its run history. This action
                  cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  onClick={() =>
                    void guard(async () => {
                      await api.deleteAgent(workspaceId, agentId);
                      navigate("/agents");
                    })
                  }
                >
                  Delete agent
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      <ErrorText>{error}</ErrorText>
      {issues.length > 0 && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
          {issues.map((issue) => (
            <p
              key={`${issue.path}:${issue.message}`}
              className="font-mono text-xs text-destructive"
            >
              {issue.path || "(root)"}: {issue.message}
            </p>
          ))}
        </div>
      )}
      {notice && <p className="text-sm text-emerald-700 dark:text-emerald-300">{notice}</p>}

      <div className="grid gap-3 sm:grid-cols-3">
        <Card className="rounded-lg">
          <CardContent className="flex items-center gap-3 py-1">
            <DeploymentIcon className="size-5 text-primary" />
            <div>
              <p className="font-medium">
                {manifest.deployment.target === "local"
                  ? "This device"
                  : manifest.deployment.target === "cloud"
                    ? "Bridge Cloud"
                    : "Self-hosted"}
              </p>
              <p className="text-xs text-muted-foreground">Deployment target</p>
            </div>
          </CardContent>
        </Card>
        <Card className="rounded-lg">
          <CardContent className="flex items-center gap-3 py-1">
            <NavArtwork name="subagent" className="size-7" />
            <div>
              <p className="font-medium">{manifest.agents.length}</p>
              <p className="text-xs text-muted-foreground">Configured agents</p>
            </div>
          </CardContent>
        </Card>
        <Card className="rounded-lg">
          <CardContent className="flex items-center gap-3 py-1">
            <History className="size-5 text-amber-600 dark:text-amber-400" />
            <div>
              <p className="font-medium">{runsList.length}</p>
              <p className="text-xs text-muted-foreground">Recorded runs</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="overview" className="w-full">
        <TabsList>
          <TabsTrigger value="overview">
            <Play /> Overview
          </TabsTrigger>
          <TabsTrigger value="runs">
            <History /> Runs
          </TabsTrigger>
          <TabsTrigger value="configure">
            <Braces /> Configure
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="pt-4">
          <Card className="rounded-lg">
            <CardHeader>
              <CardTitle>Run a task</CardTitle>
              <CardDescription>
                Send a one-off task or use Chat for a persistent conversation.
              </CardDescription>
              <CardAction>{!deployed && <Badge variant="outline">Deploy first</Badge>}</CardAction>
            </CardHeader>
            <CardContent>
              <form onSubmit={startRun} className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <div className="flex-1">
                  <Field label="Task">
                    {(id) => (
                      <Input
                        id={id}
                        value={task}
                        onChange={(event) => setTask(event.target.value)}
                        placeholder="Summarize today's priorities"
                      />
                    )}
                  </Field>
                </div>
                <Button type="submit" disabled={busy || !task.trim() || !deployed}>
                  {busy ? <Loader2 className="animate-spin" /> : <Play />} Run task
                </Button>
              </form>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="runs" className="pt-4">
          {runsList.length === 0 ? (
            <EmptyState title="No runs yet">
              Run a task from Overview or start a conversation in Chat.
            </EmptyState>
          ) : (
            <Card className="rounded-lg p-0 py-0">
              <div className="divide-y">
                {runsList.map((run) => (
                  <Button
                    key={run.id}
                    type="button"
                    variant="ghost"
                    onClick={() =>
                      void guard(async () => setOpenRun(await api.run(workspaceId, run.id)))
                    }
                    className="grid h-auto w-full rounded-none p-4 text-left transition hover:bg-muted/40 sm:grid-cols-[minmax(12rem,1fr)_auto_auto] sm:items-center"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-mono text-xs">{run.id}</span>
                      <span className="block text-xs text-muted-foreground">
                        {new Date(run.queuedAt).toLocaleString()}
                      </span>
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {run.inputTokens + run.outputTokens} tokens
                      {run.costUsd ? ` · $${Number(run.costUsd).toFixed(4)}` : ""}
                    </span>
                    <Badge variant="outline" className={statusStyle(run.status)}>
                      {run.status}
                    </Badge>
                  </Button>
                ))}
              </div>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="configure" className="space-y-4 pt-4">
          <Card className="rounded-lg">
            <CardHeader>
              <CardTitle>Change with plain language</CardTitle>
              <CardDescription>
                Bridge drafts a revised manifest. Nothing changes until you accept it.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <div className="flex-1">
                  <Field label="Instruction">
                    {(id) => (
                      <Input
                        id={id}
                        value={instruction}
                        onChange={(event) => setInstruction(event.target.value)}
                        placeholder="Add a research subagent and ask before sending email"
                      />
                    )}
                  </Field>
                </div>
                <Button
                  variant="outline"
                  disabled={busy || !instruction.trim()}
                  onClick={() =>
                    void guard(async () => {
                      const { manifest: next } = await api.editAgent(
                        workspaceId,
                        agentId,
                        instruction.trim(),
                      );
                      setProposal(next);
                    })
                  }
                >
                  <NavArtwork name="generating" className="size-4" />
                  {busy ? "Thinking" : "Propose change"}
                </Button>
              </div>
              {proposal && (
                <div className="space-y-3">
                  <Separator />
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium">Proposed manifest</p>
                    <Badge>Preview</Badge>
                  </div>
                  <pre className="max-h-80 overflow-auto rounded-lg border bg-muted/40 p-4 font-mono text-xs">
                    {JSON.stringify(proposal, null, 2)}
                  </pre>
                  <div className="flex gap-2">
                    <Button onClick={() => void save(proposal)}>
                      <Save /> Accept and save
                    </Button>
                    <Button variant="outline" onClick={() => setProposal(null)}>
                      Discard
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="rounded-lg">
            <CardHeader>
              <CardTitle>Manifest editor</CardTitle>
              <CardDescription>
                Direct JSON editing for the complete agent specification.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                spellCheck={false}
                className="min-h-96 resize-y font-mono text-xs leading-relaxed"
              />
              <Button onClick={() => void save(JSON.parse(draft))} disabled={busy}>
                <Save /> {busy ? "Saving" : "Save manifest"}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Sheet open={Boolean(openRun)} onOpenChange={(open) => !open && setOpenRun(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
          {openRun && (
            <>
              <SheetHeader>
                <SheetTitle>Run details</SheetTitle>
                <SheetDescription className="break-all font-mono">
                  {openRun.run.id}
                </SheetDescription>
              </SheetHeader>
              <div className="space-y-5 px-4 pb-6">
                <Badge variant="outline" className={statusStyle(openRun.run.status)}>
                  {openRun.run.status}
                </Badge>
                {openRun.run.output?.content && (
                  <div>
                    <p className="mb-2 text-sm font-medium">Output</p>
                    <p className="whitespace-pre-wrap rounded-lg border bg-muted/30 p-3 text-sm">
                      {openRun.run.output.content}
                    </p>
                  </div>
                )}
                {openRun.run.error && <ErrorText>{openRun.run.error}</ErrorText>}
                <div>
                  <p className="mb-2 text-sm font-medium">Execution steps</p>
                  <ol className="space-y-2">
                    {openRun.steps.map((step) => (
                      <li key={step.id} className="rounded-lg border p-3">
                        <p className="text-xs font-medium">
                          {step.seq}. {step.type}
                          {step.agentName ? ` · ${step.agentName}` : ""}
                        </p>
                        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-mono text-xs text-muted-foreground">
                          {JSON.stringify(step.data, null, 2)}
                        </pre>
                      </li>
                    ))}
                  </ol>
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
