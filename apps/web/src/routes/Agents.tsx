import { ArrowRight, CalendarClock, FileCode2, KeyRound, Plus, Search } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AgentArtwork } from "../AgentArtwork.jsx";
import { AgentIconPicker } from "../AgentIconPicker.jsx";
import {
  type AgentSummary,
  api,
  BridgeApiError,
  type Manifest,
  type TemplateSummary,
} from "../api.js";
import { describeSchedule } from "../automationSchedule.js";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs.js";
import { NavArtwork } from "../NavArtwork.jsx";
import { useWorkspaceId } from "../session.jsx";
import { ToolIcon } from "../ToolIcon.jsx";
import { EmptyState, ErrorText, Field, Input, SectionHeader, Spinner } from "../ui.jsx";

/**
 * Where agents come from.
 *
 * Templates lead, because "which of these sounds like what I want" is a much
 * easier question than "describe the system you need". Each one arrives
 * configured — tools on, permissions drawn, schedule set — so the only thing
 * between choosing it and using it is giving it a name.
 */
const CATEGORY_LABELS: Record<string, string> = {
  personal: "Personal",
  business: "Work",
  development: "Development",
  research: "Research",
  education: "Learning",
  fitness: "Health",
  custom: "Other",
};

const CATEGORY_ORDER = ["personal", "business", "development", "research", "education", "fitness"];

export function Agents() {
  const workspaceId = useWorkspaceId();
  const navigate = useNavigate();
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [category, setCategory] = useState("all");
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<TemplateSummary | null>(null);
  const [name, setName] = useState("");
  const [icon, setIcon] = useState<string | undefined>();
  const [color, setColor] = useState<string | undefined>();
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

  const create = async (body: {
    templateId?: string;
    name?: string;
    manifest?: unknown;
    icon?: string;
    color?: string;
  }) => {
    setBusy(true);
    setError(null);
    try {
      const { agent } = await api.createAgent(workspaceId, body);
      navigate(`/agents/${agent.id}`);
    } catch (cause) {
      setError(
        cause instanceof BridgeApiError ? cause.error.message : "Could not create the agent.",
      );
    } finally {
      setBusy(false);
    }
  };

  /** Opening the naming step, pre-filled from the template so it can be skipped. */
  const choose = (template: TemplateSummary) => {
    setChosen(template);
    setName(template.name);
    setIcon(template.icon ?? undefined);
    setColor(template.color ?? undefined);
    setError(null);
  };

  const shown = useMemo(() => {
    const term = query.trim().toLowerCase();
    return templates.filter(
      (template) =>
        (category === "all" || template.category === category) &&
        (!term ||
          template.name.toLowerCase().includes(term) ||
          template.description.toLowerCase().includes(term)),
    );
  }, [templates, category, query]);

  const categories = useMemo(() => {
    const present = new Set(templates.map((template) => template.category));
    return CATEGORY_ORDER.filter((one) => present.has(one));
  }, [templates]);

  if (!agents) return <Spinner label="Loading agents" />;
  const deployedCount = agents.filter((agent) => agent.status === "deployed").length;

  return (
    <div className="flex w-full flex-col gap-8">
      {agents.length > 0 && (
        <section className="flex flex-col gap-4">
          <SectionHeader
            title="Your agents"
            description={`${agents.length} total, ${deployedCount} running`}
          />
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {agents.map((agent) => (
              <Link key={agent.id} to={`/agents/${agent.id}`} className="group outline-none">
                <Card className="h-full rounded-lg transition-shadow group-hover:shadow-md group-focus-visible:ring-3 group-focus-visible:ring-ring/50">
                  <CardHeader>
                    <AgentArtwork icon={agent.icon} color={agent.color} className="mb-2 size-10" />
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
                        {agent.status === "deployed" ? "running" : agent.status}
                      </Badge>
                    </CardAction>
                  </CardHeader>
                </Card>
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="flex flex-col gap-4">
        <SectionHeader
          title={agents.length === 0 ? "Create your first agent" : "Add an agent"}
          description="Pick something close to what you want — everything about it can be changed afterwards."
        />

        <Tabs defaultValue="templates" className="w-full">
          <TabsList size="comfortable">
            <TabsTrigger value="templates">
              <AgentArtwork group className="size-5" /> Ready-made
            </TabsTrigger>
            <TabsTrigger value="describe">
              <NavArtwork name="generating" className="size-5" /> Describe it
            </TabsTrigger>
            <TabsTrigger value="blank">
              <FileCode2 /> Start empty
            </TabsTrigger>
          </TabsList>

          <TabsContent value="templates" className="space-y-4 pt-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="relative sm:w-72">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search"
                  aria-label="Search templates"
                  className="pl-8"
                />
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Button
                  size="sm"
                  variant={category === "all" ? "default" : "outline"}
                  onClick={() => setCategory("all")}
                >
                  All
                </Button>
                {categories.map((one) => (
                  <Button
                    key={one}
                    size="sm"
                    variant={category === one ? "default" : "outline"}
                    onClick={() => setCategory(one)}
                  >
                    {CATEGORY_LABELS[one] ?? one}
                  </Button>
                ))}
              </div>
            </div>

            {shown.length === 0 ? (
              <EmptyState title="Nothing matches that">Try a different word, or All.</EmptyState>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {shown.map((template) => (
                  <Card
                    key={template.id}
                    className="flex flex-col rounded-lg transition-shadow hover:shadow-md"
                  >
                    <CardHeader>
                      <AgentArtwork
                        icon={template.icon}
                        color={template.color}
                        group={template.agents > 1}
                        className="mb-2 size-10"
                      />
                      <CardTitle>{template.name}</CardTitle>
                      <CardDescription>{template.description}</CardDescription>
                    </CardHeader>
                    <CardContent className="mt-auto space-y-3">
                      <div className="flex flex-wrap gap-1.5">
                        {template.agents > 1 && (
                          <Badge variant="secondary">{template.agents} agents</Badge>
                        )}
                        {template.tools.slice(0, 3).map((tool) => (
                          <Badge key={tool} variant="outline">
                            <ToolIcon tool={tool} className="size-4 rounded-sm" />
                            {tool}
                          </Badge>
                        ))}
                      </div>
                      {template.schedules.length > 0 && (
                        <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                          <CalendarClock className="size-3.5 shrink-0" />
                          {describeSchedule(
                            template.schedules[0]?.cron ?? undefined,
                            template.schedules[0]?.every ?? undefined,
                          )}
                        </p>
                      )}
                      {/* Said before the choice, not discovered after it. */}
                      {template.setup.length > 0 && (
                        <p className="flex items-center gap-1.5 text-[12px] text-amber-700 dark:text-amber-400">
                          <KeyRound className="size-3.5 shrink-0" />
                          Needs {template.setup.join(", ")} connecting first
                        </p>
                      )}
                      <Button className="w-full" onClick={() => choose(template)} disabled={busy}>
                        Use this <ArrowRight />
                      </Button>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="describe" className="pt-4">
            <Card className="rounded-lg">
              <CardHeader>
                <CardTitle>Describe what you want</CardTitle>
                <CardDescription>
                  Say what the agent should do and what it must ask before doing. Bridge writes the
                  configuration, and you review it before anything is created.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 lg:grid-cols-[minmax(12rem,0.35fr)_minmax(20rem,1fr)_auto] lg:items-end">
                <Field label="Name it">
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
                  label="What should it do?"
                  hint="Include anything it should check with you first."
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
                  {busy ? "Designing" : "Design it"}
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="blank" className="pt-4">
            <Card className="rounded-lg">
              <CardHeader>
                <CardTitle>Start empty</CardTitle>
                <CardDescription>
                  One agent, no tools, nothing permitted. You set it up from the Setup tab.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-end">
                <div className="w-full max-w-xl">
                  <Field label="Name it">
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
                <Button
                  onClick={() => void create({ name: name.trim() })}
                  disabled={busy || !name.trim()}
                >
                  <Plus /> Create
                </Button>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        <ErrorText>{error}</ErrorText>

        {proposal && (
          <Card className="rounded-lg border-primary/25">
            <CardHeader>
              <CardTitle>Here is what Bridge would build</CardTitle>
              <CardDescription>
                {proposal.agents.length} agent{proposal.agents.length === 1 ? "" : "s"}. Nothing is
                created until you say so.
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
                  <Plus /> Create this agent
                </Button>
                <Button variant="outline" onClick={() => setProposal(null)}>
                  Discard
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </section>

      <Dialog open={chosen !== null} onOpenChange={(next) => !next && setChosen(null)}>
        <DialogContent className="sm:max-w-lg">
          <form
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              if (chosen) {
                void create({ templateId: chosen.id, name: name.trim(), icon, color });
              }
            }}
          >
            <DialogHeader>
              <DialogTitle>Set up {chosen?.name}</DialogTitle>
              <DialogDescription>
                It comes ready to go. Give it a name and a face — everything else can be changed
                later.
              </DialogDescription>
            </DialogHeader>

            <div className="flex items-start gap-4 py-6">
              <AgentIconPicker
                icon={icon}
                color={color}
                name={name}
                onChange={(next) => {
                  setIcon(next.icon);
                  setColor(next.color);
                }}
              />
              <div className="min-w-0 flex-1">
                <Field label="Call it">
                  {(id) => (
                    <Input
                      id={id}
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      required
                      autoFocus
                    />
                  )}
                </Field>
                {chosen && chosen.setup.length > 0 && (
                  <p className="mt-3 rounded-md border border-amber-300 bg-amber-50/60 px-2.5 py-2 text-[12px] text-amber-900 dark:border-amber-900 dark:bg-amber-950/20 dark:text-amber-200">
                    You will need to connect {chosen.setup.join(", ")} in Settings → Tools before
                    this can do its job.
                  </p>
                )}
              </div>
            </div>

            <ErrorText>{error}</ErrorText>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setChosen(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !name.trim()}>
                {busy ? "Creating…" : "Create agent"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
