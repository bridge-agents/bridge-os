import {
  Blocks,
  Brain,
  CalendarClock,
  Cloud,
  FolderOpen,
  Laptop,
  type LucideIcon,
  MapPin,
  Plus,
  Save,
  Server,
  ShieldCheck,
  Sparkles,
  Trash2,
  Undo2,
  UserRound,
  UsersRound,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { AgentIconPicker } from "../AgentIconPicker.jsx";
import type { Manifest, ProviderModel } from "../api.js";
import { api } from "../api.js";
import {
  calendarScheduleCron,
  describeSchedule,
  parseCalendarSchedule,
  parseInterval,
  SCHEDULE_DAYS,
  scheduleInterval,
} from "../automationSchedule.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select.js";
import { Separator } from "../components/ui/separator.js";
import { Switch } from "../components/ui/switch.js";
import { Textarea } from "../components/ui/textarea.js";
import { ProviderLogo } from "../ProviderLogo.jsx";
import { useSession } from "../session.jsx";
import { ToolIcon } from "../ToolIcon.jsx";
import {
  ACCESS_LABELS,
  SAFE_ACTIONS,
  TOOL_CATALOG,
  type ToolAccess,
  toolAccess,
  withoutTool,
  withTool,
  withToolAccess,
} from "../toolCatalog.js";
import { Input } from "../ui.jsx";

/**
 * Configuring an agent without editing a document.
 *
 * Everything here already existed in the manifest; the only thing that was
 * missing was a way to reach any single part of it without knowing where it
 * lives. So the screen is a flat list of named settings rather than a shape
 * that mirrors the schema — someone looking for "stop it spending more than
 * £5 a day" should find a row that says that, not a `runtime.limits` object.
 *
 * Nothing saves as you type. Every control edits a draft, and one button
 * commits it, because an agent that changed the moment you brushed a switch
 * would be frightening to use.
 */
function Group({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border bg-card">
      <header className="flex items-start gap-3 border-b p-4">
        <Icon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <div>
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="text-[13px] text-muted-foreground">{description}</p>
        </div>
      </header>
      <div className="divide-y">{children}</div>
    </section>
  );
}

/** One named thing you can change: what it is on the left, the control on the right. */
function Setting({
  label,
  hint,
  children,
  stacked = false,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  stacked?: boolean;
}) {
  return (
    <div
      className={
        stacked
          ? "space-y-2 p-4"
          : "flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
      }
    >
      <div className={stacked ? undefined : "min-w-0 sm:max-w-md"}>
        <p className="text-[13.5px] font-medium">{label}</p>
        {hint && <p className="text-[12.5px] text-muted-foreground">{hint}</p>}
      </div>
      <div className={stacked ? undefined : "shrink-0 sm:w-64"}>{children}</div>
    </div>
  );
}

export function AgentSetup({
  manifest,
  busy,
  onSave,
}: {
  manifest: Manifest;
  busy: boolean;
  onSave: (next: Manifest) => void;
}) {
  const { workspace } = useSession();
  const [draft, setDraft] = useState<Manifest>(() => structuredClone(manifest));
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [newPath, setNewPath] = useState("");

  // A save elsewhere on the page (or a reload) is the new truth to edit from.
  useEffect(() => setDraft(structuredClone(manifest)), [manifest]);

  useEffect(() => {
    if (!workspace) return;
    void api
      .providerModels(workspace.id)
      .then(({ models: available }) => setModels(available))
      .catch(() => setModels([]));
  }, [workspace]);

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(manifest),
    [draft, manifest],
  );

  const edit = (change: (next: Manifest) => void) =>
    setDraft((current) => {
      const next = structuredClone(current);
      change(next);
      return next;
    });

  const modelsByProvider = useMemo(() => {
    const grouped = new Map<string, ProviderModel[]>();
    for (const model of models) {
      grouped.set(model.provider, [...(grouped.get(model.provider) ?? []), model]);
    }
    return grouped;
  }, [models]);

  const entry = draft.agents.find((agent) => agent.name === draft.entryAgent) ?? draft.agents[0];
  const subagents = draft.agents.filter((agent) => agent.name !== entry?.name);
  const granted = new Set(draft.tools.map((tool) => tool.name));
  const limits = draft.runtime.limits;
  const sandbox = draft.runtime.sandbox;

  return (
    <div className="flex flex-col gap-4 pb-24">
      <Group
        icon={UserRound}
        title="Name and picture"
        description="How this agent appears everywhere in Bridge."
      >
        <div className="flex items-start gap-4 p-4">
          <AgentIconPicker
            icon={draft.meta.icon}
            color={draft.meta.color}
            name={draft.meta.name}
            onChange={({ icon, color }) =>
              edit((next) => {
                next.meta.icon = icon;
                next.meta.color = color;
              })
            }
          />
          <div className="min-w-0 flex-1 space-y-3">
            <Input
              value={draft.meta.name}
              onChange={(event) =>
                edit((next) => {
                  next.meta.name = event.target.value;
                })
              }
              placeholder="What is it called?"
              aria-label="Agent name"
            />
            <Input
              value={draft.meta.description ?? ""}
              onChange={(event) =>
                edit((next) => {
                  next.meta.description = event.target.value || undefined;
                })
              }
              placeholder="One line on what it is for"
              aria-label="Description"
            />
            <p className="text-[12px] text-muted-foreground">
              Click the picture to choose an emoji, a colour, or upload your own.
            </p>
          </div>
        </div>
      </Group>

      <Group
        icon={Sparkles}
        title="What it should do"
        description="Written to the agent at the start of every conversation. Plain English works best."
      >
        {entry && (
          <Setting label="Instructions" stacked>
            <Textarea
              value={entry.instructions}
              onChange={(event) =>
                edit((next) => {
                  const target = next.agents.find((agent) => agent.name === entry.name);
                  if (target) target.instructions = event.target.value;
                })
              }
              rows={8}
              className="resize-y leading-relaxed"
              placeholder="You are… Explain the job, how to behave, and anything it must never do."
            />
          </Setting>
        )}
      </Group>

      <Group
        icon={Brain}
        title="Which model it thinks with"
        description="The model this agent falls back to when nothing else is chosen."
      >
        <Setting
          label="Model"
          hint={
            workspace?.defaultModel
              ? `Your workspace default (${workspace.defaultModel.model}) is used ahead of this. Change it in Settings.`
              : undefined
          }
        >
          <Select
            value={`${draft.models.default.provider}/${draft.models.default.model}`}
            onValueChange={(value) =>
              edit((next) => {
                const [provider, ...rest] = value.split("/");
                if (provider) next.models.default = { provider, model: rest.join("/") };
              })
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="end">
              {modelsByProvider.size === 0 && (
                <SelectItem
                  value={`${draft.models.default.provider}/${draft.models.default.model}`}
                >
                  {draft.models.default.model}
                </SelectItem>
              )}
              {[...modelsByProvider.entries()].map(([provider, providerModels]) => (
                <SelectGroup key={provider}>
                  <SelectLabel>{providerModels[0]?.providerName ?? provider}</SelectLabel>
                  {providerModels.map((model) => (
                    <SelectItem
                      key={`${model.provider}/${model.id}`}
                      value={`${model.provider}/${model.id}`}
                    >
                      <ProviderLogo provider={model.provider} className="size-5 rounded-sm" />
                      {model.displayName}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        </Setting>
      </Group>

      <Group
        icon={Blocks}
        title="What it can use"
        description="Switch a tool on to give the agent the ability. Connectors that need a token are set up in Settings → Tools."
      >
        {TOOL_CATALOG.filter((tool) => tool.category === "Built in" || granted.has(tool.id)).map(
          (tool) => (
            <Setting key={tool.id} label={tool.name} hint={tool.description}>
              <div className="flex items-center justify-end gap-3">
                <ToolIcon tool={tool.id} className="size-7" />
                <Switch
                  checked={granted.has(tool.id)}
                  aria-label={tool.name}
                  onCheckedChange={(on) =>
                    setDraft((current) =>
                      on ? withTool(current, tool) : withoutTool(current, tool.id),
                    )
                  }
                />
              </div>
            </Setting>
          ),
        )}
      </Group>

      <Group
        icon={ShieldCheck}
        title="What it may do on its own"
        description="Anything set to ask pauses the run and waits for you. This is the setting that keeps an unattended agent safe."
      >
        {draft.tools.length === 0 ? (
          <p className="p-4 text-[13px] text-muted-foreground">
            No tools switched on yet, so there is nothing it could do without asking.
          </p>
        ) : (
          draft.tools.map((tool) => {
            const access = toolAccess(draft, tool.name);
            return (
              <Setting
                key={tool.name}
                label={TOOL_CATALOG.find((one) => one.id === tool.name)?.name ?? tool.name}
                hint={ACCESS_LABELS[access].hint}
              >
                <Select
                  value={access}
                  onValueChange={(value) =>
                    setDraft((current) => withToolAccess(current, tool.name, value as ToolAccess))
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper" align="end">
                    <SelectItem value="ask">{ACCESS_LABELS.ask.title}</SelectItem>
                    {SAFE_ACTIONS[tool.name] && (
                      <SelectItem value="safe">{ACCESS_LABELS.safe.title}</SelectItem>
                    )}
                    <SelectItem value="allow">{ACCESS_LABELS.allow.title}</SelectItem>
                    <SelectItem value="deny">{ACCESS_LABELS.deny.title}</SelectItem>
                  </SelectContent>
                </Select>
              </Setting>
            );
          })
        )}
      </Group>

      <Group
        icon={Brain}
        title="What it remembers"
        description="Memory makes an agent useful over months rather than minutes."
      >
        <Setting
          label="Remember past conversations"
          hint="Carries what you have told it into future chats."
        >
          <div className="flex justify-end">
            <Switch
              checked={draft.memory.longTerm}
              aria-label="Remember past conversations"
              onCheckedChange={(on) =>
                edit((next) => {
                  next.memory.longTerm = on;
                })
              }
            />
          </div>
        </Setting>
        <Setting
          label="Build a knowledge graph"
          hint="Connects what it learns into facts it can look up later. Runs in the background."
        >
          <div className="flex justify-end">
            <Switch
              checked={draft.memory.knowledge}
              aria-label="Build a knowledge graph"
              onCheckedChange={(on) =>
                edit((next) => {
                  next.memory.knowledge = on;
                })
              }
            />
          </div>
        </Setting>
      </Group>

      <Group
        icon={CalendarClock}
        title="When it runs by itself"
        description="Schedules run without you there. Everything above about asking permission still applies."
      >
        {draft.triggers.schedules.map((schedule, index) => (
          <ScheduleRow
            key={schedule.name}
            title={schedule.title ?? schedule.name}
            cron={schedule.cron}
            every={schedule.every}
            input={schedule.input ?? ""}
            enabled={schedule.enabled}
            onChange={(change) =>
              edit((next) => {
                const target = next.triggers.schedules[index];
                if (target) Object.assign(target, change);
              })
            }
            onRemove={() =>
              edit((next) => {
                next.triggers.schedules.splice(index, 1);
              })
            }
          />
        ))}
        <div className="p-4">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              edit((next) => {
                next.triggers.schedules.push({
                  name: `schedule-${next.triggers.schedules.length + 1}`,
                  title: "New schedule",
                  cron: "0 9 * * 1,2,3,4,5",
                  input: "",
                  enabled: true,
                  loop: { maxConsecutiveFailures: 5 },
                });
              })
            }
          >
            <Plus /> Add a schedule
          </Button>
        </div>
      </Group>

      <Group
        icon={ShieldCheck}
        title="Limits"
        description="Bounds the runtime enforces, so a mistake costs minutes rather than a month's budget."
      >
        <Setting label="Stop spending after" hint="Per day, across every run. Blank for no limit.">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">$</span>
            <Input
              type="number"
              min={0}
              step="0.5"
              value={limits.dailySpendUsd ?? ""}
              placeholder="No limit"
              aria-label="Daily spend limit in dollars"
              onChange={(event) =>
                edit((next) => {
                  const value = Number(event.target.value);
                  next.runtime.limits.dailySpendUsd =
                    event.target.value && value > 0 ? value : undefined;
                })
              }
            />
          </div>
        </Setting>
        <Setting
          label="Give up on a run after"
          hint="A run that hangs should end, not sit forever."
        >
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={1}
              value={Math.round(limits.maxRunSeconds / 60)}
              aria-label="Run time limit in minutes"
              onChange={(event) =>
                edit((next) => {
                  const minutes = Number(event.target.value);
                  if (minutes > 0) next.runtime.limits.maxRunSeconds = minutes * 60;
                })
              }
            />
            <span className="text-sm text-muted-foreground">min</span>
          </div>
        </Setting>
        <Setting label="Run at most" hint="Tasks at the same time.">
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={1}
              max={20}
              value={limits.maxConcurrentRuns}
              aria-label="Maximum concurrent runs"
              onChange={(event) =>
                edit((next) => {
                  const value = Number(event.target.value);
                  if (value > 0) next.runtime.limits.maxConcurrentRuns = value;
                })
              }
            />
            <span className="whitespace-nowrap text-sm text-muted-foreground">at once</span>
          </div>
        </Setting>
      </Group>

      <Group
        icon={FolderOpen}
        title="What it can reach"
        description="By default an agent only sees its own folder and cannot reach private addresses on your network."
      >
        <Setting
          label="Internet access"
          hint="Restricted blocks your local network and private addresses."
        >
          <Select
            value={sandbox.network}
            onValueChange={(value) =>
              edit((next) => {
                next.runtime.sandbox.network = value as typeof sandbox.network;
              })
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="end">
              <SelectItem value="none">No internet at all</SelectItem>
              <SelectItem value="restricted">Public internet only</SelectItem>
              <SelectItem value="full">Anything, including your network</SelectItem>
            </SelectContent>
          </Select>
        </Setting>
        <Setting label="Folders it may work in" stacked>
          <div className="space-y-2">
            {sandbox.allowedPaths.map((path, index) => (
              <div key={path} className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-md border bg-muted/40 px-2.5 py-1.5 text-xs">
                  {path}
                </code>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Stop allowing ${path}`}
                  onClick={() =>
                    edit((next) => {
                      next.runtime.sandbox.allowedPaths.splice(index, 1);
                    })
                  }
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
            <div className="flex gap-2">
              <Input
                value={newPath}
                onChange={(event) => setNewPath(event.target.value)}
                placeholder="~/Documents/Notes"
                aria-label="Folder to allow"
              />
              <Button
                variant="outline"
                disabled={!newPath.trim()}
                onClick={() => {
                  const path = newPath.trim();
                  edit((next) => {
                    if (!next.runtime.sandbox.allowedPaths.includes(path)) {
                      next.runtime.sandbox.allowedPaths.push(path);
                    }
                  });
                  setNewPath("");
                }}
              >
                <Plus /> Allow
              </Button>
            </div>
            <p className="text-[12px] text-muted-foreground">
              Outside these folders and its own, the agent cannot read or write anything.
            </p>
          </div>
        </Setting>
      </Group>

      {subagents.length > 0 && (
        <Group
          icon={UsersRound}
          title="Its team"
          description={`${subagents.length} helper${subagents.length === 1 ? "" : "s"} this agent can hand work to.`}
        >
          {subagents.map((agent) => (
            <Setting key={agent.name} label={agent.name} hint={agent.description} stacked>
              <Textarea
                value={agent.instructions}
                rows={4}
                className="resize-y leading-relaxed"
                aria-label={`Instructions for ${agent.name}`}
                onChange={(event) =>
                  edit((next) => {
                    const target = next.agents.find((one) => one.name === agent.name);
                    if (target) target.instructions = event.target.value;
                  })
                }
              />
            </Setting>
          ))}
        </Group>
      )}

      <Group
        icon={MapPin}
        title="Where it runs"
        description="Moving an agent between your machine and the cloud changes nothing else about it."
      >
        <Setting label="Runs on">
          <Select
            value={draft.deployment.target}
            onValueChange={(value) =>
              edit((next) => {
                next.deployment.target = value as typeof next.deployment.target;
              })
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="end">
              <SelectItem value="local">
                <Laptop className="size-4" /> This device
              </SelectItem>
              <SelectItem value="self-hosted">
                <Server className="size-4" /> Your own server
              </SelectItem>
              <SelectItem value="cloud">
                <Cloud className="size-4" /> Bridge Cloud
              </SelectItem>
            </SelectContent>
          </Select>
        </Setting>
        <Setting
          label="Keep running when Bridge is closed"
          hint="Schedules only fire while the agent is running somewhere."
        >
          <div className="flex justify-end">
            <Switch
              checked={draft.deployment.background}
              aria-label="Keep running when Bridge is closed"
              onCheckedChange={(on) =>
                edit((next) => {
                  next.deployment.background = on;
                })
              }
            />
          </div>
        </Setting>
      </Group>

      {/* Anchored, because a change you cannot find the save button for is a change you lose. */}
      {dirty && (
        <div className="sticky bottom-4 z-10 flex items-center gap-3 rounded-lg border bg-background/95 p-3 shadow-lg backdrop-blur">
          <Badge variant="secondary">Unsaved changes</Badge>
          <div className="flex-1" />
          <Button variant="outline" onClick={() => setDraft(structuredClone(manifest))}>
            <Undo2 /> Discard
          </Button>
          <Button onClick={() => onSave(draft)} disabled={busy}>
            <Save /> {busy ? "Saving…" : "Save changes"}
          </Button>
        </div>
      )}
    </div>
  );
}

/** One schedule, editable without anyone having to meet cron. */
function ScheduleRow({
  title,
  cron,
  every,
  input,
  enabled,
  onChange,
  onRemove,
}: {
  title: string;
  cron?: string;
  every?: string;
  input: string;
  enabled: boolean;
  onChange: (change: Record<string, unknown>) => void;
  onRemove: () => void;
}) {
  const calendar = parseCalendarSchedule(cron);
  const interval = parseInterval(every);
  const repeating = Boolean(every);

  return (
    <div className="space-y-3 p-4">
      <div className="flex items-center gap-3">
        <Input
          value={title}
          onChange={(event) => onChange({ title: event.target.value })}
          aria-label="Schedule name"
          className="max-w-xs"
        />
        <Badge variant="outline">{describeSchedule(cron, every)}</Badge>
        <div className="flex-1" />
        <Switch
          checked={enabled}
          aria-label={`${title} enabled`}
          onCheckedChange={(on) => onChange({ enabled: on })}
        />
        <Button variant="ghost" size="icon-sm" aria-label={`Remove ${title}`} onClick={onRemove}>
          <Trash2 />
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={repeating ? "interval" : "time"}
          onValueChange={(value) =>
            onChange(
              value === "interval"
                ? { cron: undefined, every: scheduleInterval(interval.amount, interval.unit) }
                : { every: undefined, cron: calendarScheduleCron(calendar.time, calendar.days) },
            )
          }
        >
          <SelectTrigger className="w-40" aria-label="Schedule kind">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectItem value="time">At a time</SelectItem>
            <SelectItem value="interval">On a repeat</SelectItem>
          </SelectContent>
        </Select>

        {repeating ? (
          <>
            <Input
              type="number"
              min={1}
              value={interval.amount}
              aria-label="Repeat every"
              className="w-24"
              onChange={(event) =>
                onChange({ every: scheduleInterval(event.target.value || "1", interval.unit) })
              }
            />
            <Select
              value={interval.unit}
              onValueChange={(unit) =>
                onChange({
                  every: scheduleInterval(interval.amount, unit as typeof interval.unit),
                })
              }
            >
              <SelectTrigger className="w-32" aria-label="Repeat unit">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                <SelectItem value="m">Minutes</SelectItem>
                <SelectItem value="h">Hours</SelectItem>
                <SelectItem value="d">Days</SelectItem>
              </SelectContent>
            </Select>
          </>
        ) : (
          <>
            <Input
              type="time"
              value={calendar.time}
              aria-label="Time of day"
              className="w-32"
              onChange={(event) =>
                onChange({ cron: calendarScheduleCron(event.target.value, calendar.days) })
              }
            />
            <div className="flex flex-wrap gap-1">
              {SCHEDULE_DAYS.map((day) => {
                const on = calendar.days.includes(day.value);
                return (
                  <Button
                    key={day.value}
                    type="button"
                    size="sm"
                    variant={on ? "default" : "outline"}
                    aria-pressed={on}
                    className="w-12"
                    onClick={() => {
                      const days = on
                        ? calendar.days.filter((value) => value !== day.value)
                        : [...calendar.days, day.value];
                      if (days.length === 0) return;
                      onChange({ cron: calendarScheduleCron(calendar.time, days) });
                    }}
                  >
                    {day.label}
                  </Button>
                );
              })}
            </div>
          </>
        )}
      </div>

      <Textarea
        value={input}
        rows={2}
        placeholder="What should it do each time? e.g. Summarise what changed today."
        aria-label={`What ${title} does`}
        onChange={(event) => onChange({ input: event.target.value })}
      />
      <Separator />
    </div>
  );
}
