import { Clock3, Repeat2 } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import {
  type Automation,
  type AutomationEdit,
  api,
  BridgeApiError,
  type ProviderModel,
} from "../api.js";
import {
  calendarScheduleCron,
  type IntervalUnit,
  parseCalendarSchedule,
  parseInterval,
  SCHEDULE_DAYS,
  scheduleInterval,
} from "../automationSchedule.js";
import { Button } from "../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.js";
import { Input } from "../components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs.js";
import { Textarea } from "../components/ui/textarea.js";
import { ProviderLogo } from "../ProviderLogo.jsx";
import { useSession } from "../session.jsx";
import { ErrorText, Field } from "../ui.jsx";

const WORKSPACE_DEFAULT = "__workspace_default__";
const timezones: string[] =
  typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];

/** A human scheduling form over the manifest's cron and duration fields. */
export function AutomationEditor({
  workspaceId,
  automation,
  onClose,
  onSaved,
}: {
  workspaceId: string;
  automation: Automation;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { workspace } = useSession();
  const isEvent = automation.kind === "event";
  const calendar = useMemo(
    () => parseCalendarSchedule(automation.spec.cron),
    [automation.spec.cron],
  );
  const interval = useMemo(() => parseInterval(automation.spec.every), [automation.spec.every]);
  const [title, setTitle] = useState(automation.title);
  const [mode, setMode] = useState<"time" | "interval">(
    automation.spec.every ? "interval" : "time",
  );
  const [time, setTime] = useState(calendar.time);
  const [days, setDays] = useState<number[]>(calendar.days);
  const [everyAmount, setEveryAmount] = useState(interval.amount);
  const [everyUnit, setEveryUnit] = useState<IntervalUnit>(interval.unit);
  const [timezone, setTimezone] = useState(automation.spec.timezone ?? WORKSPACE_DEFAULT);
  const [input, setInput] = useState(automation.spec.input ?? "");
  const [maxRuns, setMaxRuns] = useState(
    automation.spec.loop?.maxRuns ? String(automation.spec.loop.maxRuns) : "",
  );
  const [until, setUntil] = useState(automation.spec.loop?.until?.slice(0, 16) ?? "");
  const [modelKey, setModelKey] = useState(
    automation.spec.model
      ? `${automation.spec.model.provider}/${automation.spec.model.model}`
      : WORKSPACE_DEFAULT,
  );
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .providerModels(workspaceId)
      .then(({ models: available }) => setModels(available))
      .catch(() => setModels([]));
  }, [workspaceId]);

  const modelsByProvider = useMemo(() => {
    const grouped = new Map<string, ProviderModel[]>();
    for (const model of models) {
      grouped.set(model.provider, [...(grouped.get(model.provider) ?? []), model]);
    }
    return grouped;
  }, [models]);

  const toggleDay = (day: number) => {
    setDays((current) => {
      if (!current.includes(day)) return [...current, day];
      return current.length === 1 ? current : current.filter((value) => value !== day);
    });
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      if (!title.trim()) throw new Error("Give this automation a title.");
      const [provider, ...rest] = modelKey.split("/");
      const body: AutomationEdit = {
        title: title.trim() === automation.name ? null : title.trim(),
        input: input.trim() || null,
        model:
          modelKey !== WORKSPACE_DEFAULT && provider ? { provider, model: rest.join("/") } : null,
        loop: {
          maxRuns: maxRuns.trim() ? Number(maxRuns) : null,
          until: until ? new Date(until).toISOString() : null,
        },
      };
      if (!isEvent) {
        body.cron = mode === "time" ? calendarScheduleCron(time, days) : null;
        body.every = mode === "interval" ? scheduleInterval(everyAmount, everyUnit) : null;
        body.timezone = mode === "time" && timezone !== WORKSPACE_DEFAULT ? timezone : null;
      }

      await api.updateAutomation(workspaceId, automation.id, body);
      onSaved();
      onClose();
    } catch (cause) {
      setError(
        cause instanceof BridgeApiError
          ? cause.error.message
          : cause instanceof Error
            ? cause.message
            : "Could not save that schedule.",
      );
    } finally {
      setSaving(false);
    }
  };

  const workspaceZone = workspace?.timezone ?? "UTC";
  const workspaceModel = workspace?.defaultModel?.model ?? "Agent default";

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-2xl">
        <form onSubmit={save} className="space-y-5">
          <DialogHeader>
            <DialogTitle>Edit automation</DialogTitle>
            <DialogDescription>
              Saved to {automation.agentName}'s manifest, so it travels with the agent.
            </DialogDescription>
          </DialogHeader>

          <Field label="Title">
            {(id) => (
              <Input
                id={id}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={120}
                placeholder="Morning operations report"
              />
            )}
          </Field>

          {isEvent ? (
            <p className="rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
              Runs when <code>{automation.spec.event}</code> occurs.
            </p>
          ) : (
            <Tabs value={mode} onValueChange={(value) => setMode(value as "time" | "interval")}>
              <TabsList size="comfortable">
                <TabsTrigger value="time">
                  <Clock3 /> At a time
                </TabsTrigger>
                <TabsTrigger value="interval">
                  <Repeat2 /> On a repeat
                </TabsTrigger>
              </TabsList>

              <TabsContent value="time" className="space-y-4 pt-3">
                {!calendar.supported && automation.spec.cron && (
                  <p className="rounded-md border border-amber-300 bg-amber-50/60 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/20 dark:text-amber-200">
                    This schedule used an advanced expression. Choose a time and days to replace it.
                  </p>
                )}
                <Field label="Run at">
                  {(id) => (
                    <Input
                      id={id}
                      type="time"
                      value={time}
                      onChange={(event) => setTime(event.target.value)}
                    />
                  )}
                </Field>
                <Field label="Run on">
                  {() => (
                    <fieldset className="grid grid-cols-7 gap-1">
                      <legend className="sr-only">Run days</legend>
                      {SCHEDULE_DAYS.map((day) => {
                        const selected = days.includes(day.value);
                        return (
                          <Button
                            key={day.value}
                            type="button"
                            variant={selected ? "default" : "outline"}
                            className="h-9 min-w-0 px-0 text-xs sm:text-sm"
                            aria-pressed={selected}
                            onClick={() => toggleDay(day.value)}
                          >
                            {day.label}
                          </Button>
                        );
                      })}
                    </fieldset>
                  )}
                </Field>
                <Field label="Time zone">
                  {(id) => (
                    <Select value={timezone} onValueChange={setTimezone}>
                      <SelectTrigger id={id} className="h-9 w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent position="popper" align="start">
                        <SelectItem value={WORKSPACE_DEFAULT}>
                          Workspace Default — {workspaceZone}
                        </SelectItem>
                        {timezones.map((zone) => (
                          <SelectItem key={zone} value={zone}>
                            {zone.replace(/_/g, " ")}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </Field>
              </TabsContent>

              <TabsContent value="interval" className="pt-3">
                <Field label="Run every">
                  {(id) => (
                    <div className="grid grid-cols-[minmax(0,1fr)_minmax(9rem,0.7fr)] gap-2">
                      <Input
                        id={id}
                        type="number"
                        min={1}
                        step={1}
                        value={everyAmount}
                        onChange={(event) => setEveryAmount(event.target.value)}
                      />
                      <Select
                        value={everyUnit}
                        onValueChange={(value) => setEveryUnit(value as IntervalUnit)}
                      >
                        <SelectTrigger className="h-9 w-full" aria-label="Interval unit">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="s">Seconds</SelectItem>
                          <SelectItem value="m">Minutes</SelectItem>
                          <SelectItem value="h">Hours</SelectItem>
                          <SelectItem value="d">Days</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </Field>
              </TabsContent>
            </Tabs>
          )}

          <Field label="Model">
            {(id) => (
              <Select value={modelKey} onValueChange={setModelKey}>
                <SelectTrigger id={id} className="h-9 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper" align="start">
                  <SelectItem value={WORKSPACE_DEFAULT}>
                    Workspace Default — {workspaceModel}
                  </SelectItem>
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
            )}
          </Field>

          <Field label="What to do">
            {(id) => (
              <Textarea
                id={id}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                rows={3}
                placeholder="Summarise what changed today and flag anything that needs me."
              />
            )}
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Stop after" hint="runs — blank for no limit">
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  min={1}
                  value={maxRuns}
                  onChange={(event) => setMaxRuns(event.target.value)}
                  placeholder="No limit"
                />
              )}
            </Field>
            <Field label="Stop at" hint="blank for never">
              {(id) => (
                <Input
                  id={id}
                  type="datetime-local"
                  value={until}
                  onChange={(event) => setUntil(event.target.value)}
                />
              )}
            </Field>
          </div>

          <ErrorText>{error}</ErrorText>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save automation"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
