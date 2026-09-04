import { Check, Copy, LayoutGrid, Pencil, Plus, Sparkles, Trash2, Undo2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AgentArtwork } from "../AgentArtwork.jsx";
import {
  type AgentSummary,
  api,
  BridgeApiError,
  type Dashboard,
  type DashboardTemplateSummary,
  type Manifest,
  type Widget,
} from "../api.js";
import { Badge } from "../components/ui/badge.js";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.js";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select.js";
import { DashboardView } from "../dashboard/DashboardView.jsx";
import {
  addPage,
  addSection,
  addWidget,
  blankDashboard,
  duplicateWidget,
  moveWidget,
  removePage,
  removeWidget,
  renamePage,
  shiftWidget,
  slug,
  uniqueId,
  updateWidget,
  withIds,
} from "../dashboard/layout.js";
import { WidgetEditor } from "../dashboard/WidgetEditor.jsx";
import { NavArtwork } from "../NavArtwork.jsx";
import { useWorkspaceId } from "../session.jsx";
import { EmptyState, ErrorText, Field, Input, Spinner } from "../ui.jsx";

/**
 * Dashboards, and the editing of them.
 *
 * A scope (the workspace, or one agent) holds several dashboards; each holds
 * pages; each page holds widgets. The screen shows one at a time and switches
 * between them, because the alternative — one enormous document — made every
 * view a compromise between the things you wanted to watch.
 *
 * Editing works on a draft and commits on Save. Every change is an edit to the
 * document that gets stored, so there is no layout state living only in the
 * browser that could disagree with what an AI or a hand edit would produce.
 */
export function Dashboards() {
  const workspaceId = useWorkspaceId();
  const [params, setParams] = useSearchParams();
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [templates, setTemplates] = useState<DashboardTemplateSummary[]>([]);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [saved, setSaved] = useState<Dashboard[]>([]);
  const [draft, setDraft] = useState<Dashboard[] | null>(null);
  const [page, setPage] = useState<string | undefined>();
  const [editingWidget, setEditingWidget] = useState<Widget | null | "new">(null);
  const [addTo, setAddTo] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [instruction, setInstruction] = useState("");
  const [designing, setDesigning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const target = params.get("agent") ?? "workspace";
  const agentId = target === "workspace" ? "" : target;
  const editing = draft !== null;
  const list = draft ?? saved;
  const currentId = params.get("view") ?? list[0]?.id ?? "";
  const current = list.find((one) => one.id === currentId) ?? list[0];

  useEffect(() => {
    void Promise.all([api.agents(workspaceId), api.dashboardTemplates()]).then(
      ([{ agents: found }, { templates: catalog }]) => {
        setAgents(found);
        setTemplates(catalog);
      },
    );
  }, [workspaceId]);

  const load = useCallback(async () => {
    if (agentId) {
      const { agent } = await api.agent(workspaceId, agentId);
      setManifest(agent.manifest);
      setSaved(withIds(agent.manifest.dashboards ?? []));
    } else {
      setManifest(null);
      const { dashboards } = await api.workspaceDashboards(workspaceId);
      setSaved(withIds(dashboards));
    }
    setDraft(null);
  }, [workspaceId, agentId]);

  useEffect(() => {
    void load().catch(() => setError("Could not load dashboards."));
  }, [load]);

  /** Every editing action funnels through here, on the dashboard in view. */
  const change = (apply: (dashboard: Dashboard) => Dashboard) =>
    setDraft((currentDraft) =>
      (currentDraft ?? saved).map((one) => (one.id === current?.id ? apply(one) : one)),
    );

  const commit = async (next: Dashboard[]) => {
    setBusy(true);
    setError(null);
    try {
      const ready = withIds(next);
      if (agentId && manifest) {
        await api.updateAgent(workspaceId, agentId, {
          ...manifest,
          dashboards: ready as Manifest["dashboards"],
        });
      } else {
        await api.updateWorkspaceDashboards(workspaceId, ready);
      }
      await load();
    } catch (cause) {
      setError(cause instanceof BridgeApiError ? cause.error.message : "Could not save that.");
    } finally {
      setBusy(false);
    }
  };

  const createDashboard = (from?: Dashboard) => {
    const base = from ?? blankDashboard("New dashboard");
    const id = uniqueId(
      list.map((one) => one.id ?? ""),
      base.id || slug(base.name),
    );
    const next = [...list, { ...base, id }];
    setDraft(next);
    setParams({ ...(agentId ? { agent: agentId } : {}), view: id }, { replace: true });
  };

  const scopeName = agentId
    ? (agents?.find((agent) => agent.id === agentId)?.name ?? "Agent")
    : "Workspace";

  const designerModel = manifest?.models?.default;

  const design = async () => {
    if (!instruction.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const designer = { provider: designerModel?.provider, model: designerModel?.model };
      const result = current
        ? agentId
          ? await api.editDashboard(workspaceId, agentId, instruction.trim(), designer)
          : await api.editWorkspaceDashboard(workspaceId, current, instruction.trim(), designer)
        : await api.draftDashboard(workspaceId, instruction.trim(), scopeName, designer);
      // Straight into the draft, where it can be adjusted by hand before saving.
      const replacing = current;
      const next = replacing
        ? list.map((one) =>
            one.id === replacing.id ? { ...result.dashboard, id: replacing.id } : one,
          )
        : [...list, { ...result.dashboard, id: slug(result.dashboard.name) }];
      setDraft(withIds(next));
      setInstruction("");
      setDesigning(false);
    } catch (cause) {
      setError(
        cause instanceof BridgeApiError ? cause.error.message : "Could not design that dashboard.",
      );
    } finally {
      setBusy(false);
    }
  };

  const firstPage = current?.pages[0]?.id;
  const activePage = useMemo(() => page ?? firstPage, [page, firstPage]);

  if (!agents) return <Spinner label="Loading dashboards" />;

  return (
    <div className="flex w-full flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={target}
          onValueChange={(value) => {
            setParams(value === "workspace" ? {} : { agent: value }, { replace: true });
            setPage(undefined);
          }}
        >
          <SelectTrigger className="w-full sm:w-56" aria-label="Dashboard scope">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="start">
            <SelectGroup>
              <SelectLabel>Dashboards for</SelectLabel>
              <SelectItem value="workspace">
                <NavArtwork name="dashboard" className="size-4" /> Whole workspace
              </SelectItem>
              {agents.map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  <AgentArtwork icon={agent.icon} color={agent.color} className="size-4" />
                  {agent.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>

        {/* One tab per dashboard in this scope. */}
        {list.length > 0 && (
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
            {list.map((one) => (
              <Button
                key={one.id}
                size="sm"
                variant={one.id === current?.id ? "default" : "ghost"}
                onClick={() => {
                  setParams(
                    { ...(agentId ? { agent: agentId } : {}), view: one.id ?? "" },
                    { replace: true },
                  );
                  setPage(undefined);
                }}
              >
                {one.name}
              </Button>
            ))}
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="New dashboard"
              onClick={() => createDashboard()}
            >
              <Plus />
            </Button>
          </div>
        )}

        <div className="flex items-center gap-2">
          {editing ? (
            <>
              <Badge variant="secondary">Editing</Badge>
              <Button variant="outline" size="sm" onClick={() => setDraft(null)}>
                <Undo2 /> Discard
              </Button>
              <Button size="sm" disabled={busy} onClick={() => void commit(draft ?? [])}>
                <Check /> {busy ? "Saving…" : "Save"}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={() => setDesigning(true)}>
                <Sparkles /> Describe
              </Button>
              {current && (
                <Button variant="outline" size="sm" onClick={() => setDraft(saved)}>
                  <Pencil /> Edit
                </Button>
              )}
            </>
          )}

          {current && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Dashboard options">
                  <LayoutGrid />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={() => {
                    setRenaming(current.id ?? "");
                    setRenameValue(current.name);
                  }}
                >
                  <Pencil /> Rename dashboard
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => createDashboard({ ...current, name: `${current.name} copy` })}
                >
                  <Copy /> Duplicate dashboard
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => void commit(list.filter((one) => one.id !== current.id))}
                >
                  <Trash2 /> Delete dashboard
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      <ErrorText>{error}</ErrorText>

      {/* Naming the page sits with the page, not at the far end of the screen. */}
      {editing && current && activePage && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/20 px-3 py-2">
          <span className="text-[12.5px] text-muted-foreground">This page is called</span>
          <Input
            value={current.pages.find((one) => one.id === activePage)?.title ?? ""}
            onChange={(event) => change((one) => renamePage(one, activePage, event.target.value))}
            className="h-8 max-w-[14rem]"
            aria-label="Page name"
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => change((one) => addPage(one, `Page ${(one.pages.length ?? 0) + 1}`))}
          >
            <Plus /> Page
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => change((one) => addSection(one, activePage, "New section"))}
          >
            <Plus /> Section
          </Button>
          {current.pages.length > 1 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                change((one) => removePage(one, activePage));
                setPage(undefined);
              }}
            >
              <Trash2 /> Delete page
            </Button>
          )}
        </div>
      )}

      {current ? (
        <DashboardView
          workspaceId={workspaceId}
          dashboard={current}
          activePage={activePage}
          onPageChange={setPage}
          edit={
            editing
              ? {
                  onMove: (id, to) => change((one) => moveWidget(one, id, to)),
                  onShift: (id, delta) => change((one) => shiftWidget(one, id, delta)),
                  onResize: (id, w) => change((one) => updateWidget(one, id, { w })),
                  onEdit: (widget) => setEditingWidget(widget),
                  onDuplicate: (id) => change((one) => duplicateWidget(one, id)),
                  onRemove: (id) => change((one) => removeWidget(one, id)),
                  onAdd: (sectionId) => {
                    setAddTo(sectionId);
                    setEditingWidget("new");
                  },
                }
              : undefined
          }
        />
      ) : (
        <div className="space-y-5">
          <EmptyState title={`No dashboards for ${scopeName.toLowerCase()} yet`}>
            Start from a ready-made one below, describe what you want to see, or build one widget at
            a time.
          </EmptyState>
          <div className="flex flex-wrap justify-center gap-2">
            <Button onClick={() => createDashboard()}>
              <Plus /> Start empty
            </Button>
            <Button variant="outline" onClick={() => setDesigning(true)}>
              <Sparkles /> Describe what you need
            </Button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {templates.map((template) => (
              <button
                key={template.id}
                type="button"
                onClick={() => void commit([...list, { ...template.dashboard, id: template.id }])}
                className="rounded-lg border p-4 text-left transition hover:border-primary/40 hover:shadow-sm"
              >
                <p className="text-sm font-medium">{template.name}</p>
                <p className="mt-0.5 text-[12.5px] text-muted-foreground">{template.description}</p>
                <Badge variant="outline" className="mt-2.5">
                  {template.widgets} widgets
                </Badge>
              </button>
            ))}
          </div>
        </div>
      )}

      {editingWidget !== null && (
        <WidgetEditor
          workspaceId={workspaceId}
          widget={editingWidget === "new" ? null : editingWidget}
          agents={agents}
          onClose={() => {
            setEditingWidget(null);
            setAddTo(null);
          }}
          onSave={(widget) => {
            if (editingWidget === "new" && addTo && activePage) {
              change((one) => addWidget(one, activePage, addTo, widget));
            } else {
              change((one) => updateWidget(one, widget.id, widget));
            }
            setEditingWidget(null);
            setAddTo(null);
          }}
        />
      )}

      <Dialog open={renaming !== null} onOpenChange={(next) => !next && setRenaming(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename dashboard</DialogTitle>
            <DialogDescription>Only the label changes; nothing on it moves.</DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <Field label="Name">
              {(id) => (
                <Input
                  id={id}
                  value={renameValue}
                  onChange={(event) => setRenameValue(event.target.value)}
                  autoFocus
                />
              )}
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenaming(null)}>
              Cancel
            </Button>
            <Button
              disabled={!renameValue.trim()}
              onClick={() => {
                change((one) => ({ ...one, name: renameValue.trim() }));
                setRenaming(null);
              }}
            >
              Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={designing} onOpenChange={setDesigning}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{current ? "Change this dashboard" : "Design a dashboard"}</DialogTitle>
            <DialogDescription>
              Describe what you want to watch. Bridge builds it and puts it straight into the
              editor, so you can adjust anything before saving.
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <Field label="What do you need to see?">
              {(id) => (
                <Input
                  id={id}
                  value={instruction}
                  onChange={(event) => setInstruction(event.target.value)}
                  placeholder="Spend, failures, and what is waiting on me"
                  autoFocus
                />
              )}
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDesigning(false)}>
              <X /> Cancel
            </Button>
            <Button disabled={busy || !instruction.trim()} onClick={() => void design()}>
              <Sparkles /> {busy ? "Designing…" : "Build it"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
