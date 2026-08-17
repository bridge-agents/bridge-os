import { ArrowRight, FileCode2, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AgentArtwork } from "../AgentArtwork.jsx";
import {
  type AgentSummary,
  api,
  BridgeApiError,
  type Manifest,
  type TemplateSummary,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs.js";
import { NavArtwork } from "../NavArtwork.jsx";
import { useWorkspaceId } from "../session.jsx";
import { ToolIcon } from "../ToolIcon.jsx";
import { EmptyState, ErrorText, Field, Input, SectionHeader, Spinner } from "../ui.jsx";

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
    } catch (cause) {
      setError(
        cause instanceof BridgeApiError ? cause.error.message : "Could not create the agent.",
      );
    } finally {
      setBusy(false);
    }
  };

  if (!agents) return <Spinner label="Loading agents" />;
  const deployedCount = agents.filter((agent) => agent.status === "deployed").length;

  return (
    <div className="flex w-full flex-col gap-8">
      <section className="flex flex-col gap-4">
        <SectionHeader
          title="Create an agent"
          description="Start with a focused template, a blank manifest, or describe the outcome and let Bridge draft the configuration."
        />

        <Tabs defaultValue="describe" className="w-full">
          <TabsList size="comfortable">
            <TabsTrigger value="describe">
              <NavArtwork name="generating" className="size-5" /> Describe
            </TabsTrigger>
            <TabsTrigger value="templates">
              <AgentArtwork group className="size-5" /> Templates
            </TabsTrigger>
            <TabsTrigger value="blank">
              <FileCode2 /> Blank
            </TabsTrigger>
          </TabsList>

          <TabsContent value="describe" className="pt-4">
            <Card className="rounded-lg">
              <CardHeader>
                <CardTitle>Design with Bridge</CardTitle>
                <CardDescription>
                  Describe the job, boundaries, and approval requirements.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 lg:grid-cols-[minmax(12rem,0.35fr)_minmax(20rem,1fr)_auto] lg:items-end">
                <Field label="Agent name">
                  {(id) => (
                    <Input
                      id={id}
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder="Client operations"
                    />
                  )}
                </Field>
                <Field
                  label="What should this agent do?"
                  hint="Include constraints and actions that should require approval."
                >
                  {(id) => (
                    <Input
                      id={id}
                      value={description}
                      onChange={(event) => setDescription(event.target.value)}
                      placeholder="Triage support requests and draft replies, but ask before issuing refunds"
                    />
                  )}
                </Field>
                <Button
                  disabled={busy || !description.trim()}
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
                      } catch (cause) {
                        setError(
                          cause instanceof BridgeApiError
                            ? cause.error.message
                            : "Could not design that agent.",
                        );
                      } finally {
                        setBusy(false);
                      }
                    })()
                  }
                >
                  <NavArtwork name="generating" className="size-4" />
                  {busy ? "Designing" : "Generate manifest"}
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="templates" className="pt-4">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {templates.map((template) => (
                <Card key={template.id} className="rounded-lg transition-shadow hover:shadow-md">
                  <CardHeader>
                    <AgentArtwork group={template.agents > 1} className="mb-2 size-9" />
                    <CardTitle>{template.name}</CardTitle>
                    <CardDescription>{template.description}</CardDescription>
                    <CardAction>
                      <Button
                        size="icon-sm"
                        onClick={() => void create({ templateId: template.id })}
                        disabled={busy}
                        aria-label={`Use ${template.name}`}
                      >
                        <ArrowRight />
                      </Button>
                    </CardAction>
                  </CardHeader>
                  <CardContent className="flex flex-wrap gap-1.5">
                    <Badge variant="secondary">
                      {template.agents} agent{template.agents === 1 ? "" : "s"}
                    </Badge>
                    {template.tools.slice(0, 3).map((tool) => (
                      <Badge key={tool} variant="outline">
                        <ToolIcon tool={tool} className="size-4 rounded-sm" />
                        {tool}
                      </Badge>
                    ))}
                  </CardContent>
                </Card>
              ))}
            </div>
          </TabsContent>

          <TabsContent value="blank" className="pt-4">
            <Card className="rounded-lg">
              <CardHeader>
                <CardTitle>Blank manifest</CardTitle>
                <CardDescription>
                  Create the minimum valid agent, then configure it in the agent workspace.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-end">
                <div className="w-full max-w-xl">
                  <Field label="Agent name">
                    {(id) => (
                      <Input
                        id={id}
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        placeholder="My assistant"
                      />
                    )}
                  </Field>
                </div>
                <Button onClick={() => void create({})} disabled={busy || !name.trim()}>
                  <Plus /> Create blank agent
                </Button>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        <ErrorText>{error}</ErrorText>

        {proposal && (
          <Card className="rounded-lg border-primary/25">
            <CardHeader>
              <CardTitle>Proposed manifest</CardTitle>
              <CardDescription>
                {proposal.agents.length} configured agent{proposal.agents.length === 1 ? "" : "s"}.
                Review before creating.
              </CardDescription>
              <CardAction>
                <Badge>Draft</Badge>
              </CardAction>
            </CardHeader>
            <CardContent className="space-y-3">
              <pre className="max-h-80 overflow-auto rounded-lg border bg-muted/40 p-4 font-mono text-xs">
                {JSON.stringify(proposal, null, 2)}
              </pre>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void create({ manifest: proposal })}>
                  <AgentArtwork group={proposal.agents.length > 1} className="size-4" /> Create this
                  agent
                </Button>
                <Button variant="outline" onClick={() => setProposal(null)}>
                  Discard
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <SectionHeader
          title="Agent fleet"
          description={`${agents.length} total, ${deployedCount} deployed`}
        />
        {agents.length === 0 ? (
          <EmptyState title="No agents yet">
            Create a blank agent or start from a template above.
          </EmptyState>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {agents.map((agent) => (
              <Link key={agent.id} to={`/agents/${agent.id}`} className="group outline-none">
                <Card className="h-full rounded-lg transition-shadow group-hover:shadow-md group-focus-visible:ring-3 group-focus-visible:ring-ring/50">
                  <CardHeader>
                    <AgentArtwork className="mb-2 size-9" />
                    <CardTitle>{agent.name}</CardTitle>
                    <CardDescription className="font-mono text-xs">{agent.slug}</CardDescription>
                    <CardAction>
                      <Badge
                        variant={agent.status === "deployed" ? "secondary" : "outline"}
                        className={
                          agent.status === "deployed"
                            ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                            : undefined
                        }
                      >
                        {agent.status}
                      </Badge>
                    </CardAction>
                  </CardHeader>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
