import {
  Activity,
  BarChart3,
  CalendarDays,
  CheckSquare,
  Gauge,
  Link2,
  type LucideIcon,
  MessageSquare,
  ScrollText,
  Table2,
  Type,
  UsersRound,
} from "lucide-react";
import { useEffect, useState } from "react";
import { api, type DataSourceInfo, type Widget } from "../api.js";
import { Button } from "../components/ui/button.js";
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
import { Textarea } from "../components/ui/textarea.js";
import { Field, Input } from "../ui.jsx";

/**
 * Choosing a widget and saying what it should track.
 *
 * The kind of data a widget can draw is a property of the widget, not a
 * preference: a metric panel given a 14-day series renders an empty box. So
 * the source list is filtered to what this type can actually display, which
 * makes the mismatch unrepresentable rather than merely discouraged.
 */
interface WidgetKind {
  type: string;
  name: string;
  description: string;
  icon: LucideIcon;
  /** Source shape this widget draws, if it binds to data at all. */
  binds?: "metric" | "series" | "rows";
}

export const WIDGET_KINDS: WidgetKind[] = [
  {
    type: "metric",
    name: "Number",
    description: "One big figure, like spend or runs today.",
    icon: Gauge,
    binds: "metric",
  },
  {
    type: "chart",
    name: "Chart",
    description: "A value per day over the last two weeks.",
    icon: BarChart3,
    binds: "series",
  },
  {
    type: "table",
    name: "Table",
    description: "Rows of data, like recent runs.",
    icon: Table2,
    binds: "rows",
  },
  {
    type: "activity",
    name: "Activity",
    description: "What has been happening in the workspace.",
    icon: Activity,
    binds: "rows",
  },
  {
    type: "logs",
    name: "Logs",
    description: "Recent execution steps.",
    icon: ScrollText,
    binds: "rows",
  },
  {
    type: "taskList",
    name: "Tasks",
    description: "Open work, as a list.",
    icon: CheckSquare,
    binds: "rows",
  },
  {
    type: "approvalQueue",
    name: "Approvals",
    description: "Anything waiting on your decision.",
    icon: CheckSquare,
  },
  {
    type: "agentStatus",
    name: "Agents",
    description: "Every agent and whether it is running.",
    icon: UsersRound,
  },
  { type: "calendar", name: "Calendar", description: "What is scheduled.", icon: CalendarDays },
  {
    type: "chat",
    name: "Chat",
    description: "A shortcut into a conversation.",
    icon: MessageSquare,
  },
  { type: "text", name: "Note", description: "A heading or a note to yourself.", icon: Type },
  { type: "embed", name: "Link", description: "A link out to another tool.", icon: Link2 },
];

const kindOf = (type: string) => WIDGET_KINDS.find((kind) => kind.type === type);

export function WidgetEditor({
  workspaceId,
  widget,
  agents,
  onSave,
  onClose,
}: {
  workspaceId: string;
  /** An existing widget to change, or null to pick a new one. */
  widget: Widget | null;
  agents: { id: string; name: string }[];
  onSave: (widget: Widget) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Widget | null>(widget);
  const [sources, setSources] = useState<DataSourceInfo[]>([]);

  useEffect(() => setDraft(widget), [widget]);

  useEffect(() => {
    void api
      .dataSources(workspaceId)
      .then(({ sources: list }) => setSources(list))
      .catch(() => setSources([]));
  }, [workspaceId]);

  const choose = (kind: WidgetKind) => {
    const usable = sources.filter((source) => source.kind === kind.binds);
    setDraft({
      id: kind.type,
      type: kind.type,
      title: kind.name,
      ...(kind.binds ? { source: usable[0]?.name ?? "" } : {}),
      ...(kind.type === "text" ? { content: "" } : {}),
      ...(kind.type === "embed" ? { url: "https://" } : {}),
    });
  };

  const patch = (change: Partial<Widget>) =>
    setDraft((current) => (current ? { ...current, ...change } : current));

  const kind = draft ? kindOf(draft.type) : undefined;
  const usable = sources.filter((source) => source.kind === kind?.binds);
  const incomplete =
    !draft ||
    (kind?.binds && !draft.source) ||
    (draft.type === "embed" && !/^https?:\/\/.+/.test(draft.url ?? ""));

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[calc(100vh-4rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{widget ? "Edit widget" : draft ? "Set it up" : "Add a widget"}</DialogTitle>
          <DialogDescription>
            {draft
              ? "Give it a heading and choose what it should track."
              : "Pick what you want to see."}
          </DialogDescription>
        </DialogHeader>

        {!draft ? (
          <div className="grid gap-2 py-2 sm:grid-cols-2">
            {WIDGET_KINDS.map((option) => (
              <button
                key={option.type}
                type="button"
                onClick={() => choose(option)}
                className="flex items-start gap-2.5 rounded-lg border p-3 text-left transition hover:border-primary/40 hover:bg-accent/40"
              >
                <option.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0">
                  <span className="block text-[13.5px] font-medium">{option.name}</span>
                  <span className="block text-[12px] text-muted-foreground">
                    {option.description}
                  </span>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="space-y-4 py-2">
            <Field label="Heading" hint="Leave blank for no heading.">
              {(id) => (
                <Input
                  id={id}
                  value={draft.title ?? ""}
                  onChange={(event) => patch({ title: event.target.value || undefined })}
                  placeholder={kind?.name}
                />
              )}
            </Field>

            {kind?.binds && (
              <Field
                label="What it tracks"
                hint={
                  usable.length === 0
                    ? "This deployment has nothing of this shape to show yet."
                    : undefined
                }
              >
                {(id) => (
                  <Select
                    value={draft.source ?? ""}
                    onValueChange={(value) => patch({ source: value })}
                  >
                    <SelectTrigger id={id} className="w-full">
                      <SelectValue placeholder="Choose a source" />
                    </SelectTrigger>
                    <SelectContent position="popper">
                      {usable.map((source) => (
                        <SelectItem key={source.name} value={source.name}>
                          {source.description}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </Field>
            )}

            {draft.type === "chart" && (
              <Field label="Shape">
                {(id) => (
                  <Select
                    value={draft.chartType ?? "line"}
                    onValueChange={(value) =>
                      patch({ chartType: value as "line" | "bar" | "area" })
                    }
                  >
                    <SelectTrigger id={id} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent position="popper">
                      <SelectItem value="line">Line</SelectItem>
                      <SelectItem value="bar">Bars</SelectItem>
                      <SelectItem value="area">Filled</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              </Field>
            )}

            {draft.type === "text" && (
              <Field label="Text">
                {(id) => (
                  <Textarea
                    id={id}
                    rows={4}
                    value={draft.content ?? ""}
                    onChange={(event) => patch({ content: event.target.value })}
                    placeholder="Anything you want written here."
                  />
                )}
              </Field>
            )}

            {draft.type === "embed" && (
              <Field label="Link" hint="Opens in a new tab.">
                {(id) => (
                  <Input
                    id={id}
                    value={draft.url ?? ""}
                    onChange={(event) => patch({ url: event.target.value })}
                    placeholder="https://example.com"
                  />
                )}
              </Field>
            )}

            {(draft.type === "chat" || draft.type === "agentStatus") && agents.length > 0 && (
              <Field label="Agent" hint="Leave on all to cover the whole workspace.">
                {(id) => (
                  <Select
                    value={draft.agent ?? "all"}
                    onValueChange={(value) => patch({ agent: value === "all" ? undefined : value })}
                  >
                    <SelectTrigger id={id} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent position="popper">
                      <SelectItem value="all">All agents</SelectItem>
                      {agents.map((agent) => (
                        <SelectItem key={agent.id} value={agent.name}>
                          {agent.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </Field>
            )}

            <Field label="Width">
              {(id) => (
                <Select
                  value={String(draft.w ?? "")}
                  onValueChange={(value) => patch({ w: value ? Number(value) : undefined })}
                >
                  <SelectTrigger id={id} className="w-full">
                    <SelectValue placeholder="Natural" />
                  </SelectTrigger>
                  <SelectContent position="popper">
                    <SelectItem value="1">Quarter</SelectItem>
                    <SelectItem value="2">Half</SelectItem>
                    <SelectItem value="3">Three quarters</SelectItem>
                    <SelectItem value="4">Full width</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </Field>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          {draft && (
            <Button disabled={Boolean(incomplete)} onClick={() => onSave(draft)}>
              {widget ? "Save widget" : "Add widget"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
