import bridgeMark from "@bridge/ui/assets/bridge-icon-transparent.png";
import {
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  CircleGauge,
  Clock3,
  Moon,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Sun,
  Trash2,
} from "lucide-react";
import { type ComponentType, useCallback, useEffect, useState } from "react";
import { NavLink, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { AgentArtwork } from "./AgentArtwork.jsx";
import { type AgentSummary, api, type ConversationSummary } from "./api.js";
import { newChatParams } from "./chatNavigation.js";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./components/ui/alert-dialog.js";
import { Badge } from "./components/ui/badge.js";
import { Button, buttonVariants } from "./components/ui/button.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./components/ui/collapsible.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu.js";
import { Input } from "./components/ui/input.js";
import { ScrollArea } from "./components/ui/scroll-area.js";
import { Separator } from "./components/ui/separator.js";
import { Sheet, SheetContent, SheetTitle } from "./components/ui/sheet.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "./components/ui/tooltip.js";
import { cn } from "./lib/utils.js";
import { NavArtwork } from "./NavArtwork.jsx";
import { useSession } from "./session.jsx";
import { useTheme } from "./theme.jsx";

const COLLAPSED_KEY = "bridge:sidebar-collapsed";
const SECTIONS_KEY = "bridge:sidebar-sections";

interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  iconClassName?: string;
  contentClassName?: string;
  startsNewChat?: boolean;
  planned?: string;
  badge?: number;
}

const ChatIcon = ({ className }: { className?: string }) => (
  <NavArtwork name="chat" className={className} />
);
const DashboardIcon = ({ className }: { className?: string }) => (
  <NavArtwork name="dashboard" className={className} />
);
const ApprovalsIcon = ({ className }: { className?: string }) => (
  <NavArtwork name="approvals" className={className} />
);
const ChannelsIcon = ({ className }: { className?: string }) => (
  <NavArtwork name="channels" className={className} />
);
const SettingsIcon = ({ className }: { className?: string }) => (
  <NavArtwork name="settings" className={className} />
);
const AutomationsIcon = ({ className }: { className?: string }) => (
  <NavArtwork name="automations" className={className} />
);
const KnowledgeIcon = ({ className }: { className?: string }) => (
  <NavArtwork name="knowledge" className={className} />
);

function useStoredFlag(key: string, initial: boolean) {
  const [value, setValue] = useState(() => {
    const saved = localStorage.getItem(key);
    return saved === null ? initial : saved === "1";
  });
  const set = useCallback(
    (next: boolean) => {
      setValue(next);
      localStorage.setItem(key, next ? "1" : "0");
    },
    [key],
  );
  return [value, set] as const;
}

function useSections(initial: Record<string, boolean>) {
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    try {
      return { ...initial, ...JSON.parse(localStorage.getItem(SECTIONS_KEY) ?? "{}") };
    } catch {
      return initial;
    }
  });
  const setSection = useCallback((key: string, value: boolean) => {
    setOpen((current) => {
      const next = { ...current, [key]: value };
      localStorage.setItem(SECTIONS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);
  return [open, setSection] as const;
}

function NavigationItem({
  item,
  collapsed,
  onNavigate,
}: {
  item: NavItem;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const Icon = item.icon;
  const location = useLocation();
  const navigate = useNavigate();
  const isActive = !item.planned && location.pathname === item.to;
  const content = item.planned ? (
    <div
      aria-disabled="true"
      className={cn(
        buttonVariants({ variant: "ghost", size: collapsed ? "icon" : "default" }),
        "w-full cursor-not-allowed justify-start text-sidebar-foreground/45 hover:bg-transparent hover:text-sidebar-foreground/45",
        collapsed && "justify-center",
      )}
    >
      <span className={cn("flex min-w-0 items-center gap-1.5", item.contentClassName)}>
        <Icon className={cn("size-5", item.iconClassName)} />
        {!collapsed && <span className="truncate">{item.label}</span>}
      </span>
      {!collapsed && (
        <Badge variant="outline" className="ml-auto h-4 px-1 text-[10px] font-normal">
          {item.planned}
        </Badge>
      )}
    </div>
  ) : (
    <NavLink
      to={item.to}
      onClick={(event) => {
        if (item.startsNewChat) {
          event.preventDefault();
          navigate({ pathname: "/chat", search: newChatParams().toString() });
        }
        onNavigate?.();
      }}
      className={cn(
        buttonVariants({ variant: "ghost", size: collapsed ? "icon" : "default" }),
        "relative w-full justify-start text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        collapsed && "justify-center",
        isActive &&
          "bg-sidebar-accent font-medium text-sidebar-accent-foreground before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-sidebar-primary",
      )}
    >
      <span className={cn("flex min-w-0 items-center gap-1.5", item.contentClassName)}>
        <Icon className={cn("size-5", item.iconClassName)} />
        {!collapsed && <span className="truncate">{item.label}</span>}
      </span>
      {!collapsed && item.badge ? (
        <Badge className="ml-auto h-5 min-w-5 bg-amber-100 px-1.5 text-amber-800 hover:bg-amber-100 dark:bg-amber-950 dark:text-amber-300">
          {item.badge}
        </Badge>
      ) : null}
    </NavLink>
  );

  if (!collapsed) return content;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{content}</TooltipTrigger>
      <TooltipContent side="right">{item.label}</TooltipContent>
    </Tooltip>
  );
}

function NavigationSection({
  label,
  open,
  onOpenChange,
  children,
}: {
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className="px-2">
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="mb-1 w-full justify-start px-2 text-xs font-medium text-sidebar-foreground/55 hover:bg-sidebar-accent"
        >
          <ChevronDown className={cn("transition-transform", !open && "-rotate-90")} />
          {label}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-0.5 pb-2">{children}</CollapsibleContent>
    </Collapsible>
  );
}

interface SidebarPanelProps {
  collapsed: boolean;
  agents: AgentSummary[];
  history: ConversationSummary[];
  pendingApprovals: number;
  sections: Record<string, boolean>;
  setSection: (key: string, value: boolean) => void;
  onNavigate?: () => void;
  onCollapse?: () => void;
  onConversationUpdate: (conversation: ConversationSummary) => void;
  onConversationDelete: (conversationId: string) => void;
}

function ConversationItem({
  conversation,
  active,
  workspaceId,
  onNavigate,
  onUpdate,
  onDelete,
}: {
  conversation: ConversationSummary;
  active: boolean;
  workspaceId: string;
  onNavigate?: () => void;
  onUpdate: (conversation: ConversationSummary) => void;
  onDelete: (conversationId: string) => void;
}) {
  const navigate = useNavigate();
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [title, setTitle] = useState(conversation.title ?? "");
  const [busy, setBusy] = useState(false);
  const label = conversation.title ?? `${conversation.agentName} conversation`;
  const displayLabel = label.length > 28 ? `${label.slice(0, 28).trimEnd()}...` : label;

  const update = async (body: { title?: string; pinned?: boolean }) => {
    setBusy(true);
    try {
      const { conversation: saved } = await api.updateConversation(
        workspaceId,
        conversation.id,
        body,
      );
      onUpdate({ ...conversation, ...saved });
      setRenameOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api.deleteConversation(workspaceId, conversation.id);
      onDelete(conversation.id);
      if (active) navigate(`/chat?agent=${conversation.agentId}`, { replace: true });
      setDeleteOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div
        className={cn(
          "group/conversation grid min-h-10 w-full grid-cols-[minmax(0,1fr)_2rem] items-center gap-1 overflow-hidden rounded-md px-1 text-sm text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
          active && "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
        )}
      >
        <NavLink
          to={`/chat?agent=${conversation.agentId}&conversation=${conversation.id}`}
          onClick={onNavigate}
          title={label}
          className="flex min-w-0 items-center gap-2 overflow-hidden px-1 py-2"
        >
          {conversation.pinned ? (
            <Pin className="size-3.5 shrink-0" />
          ) : (
            <Clock3 className="size-3.5 shrink-0" />
          )}
          <span className="block min-w-0 truncate">{displayLabel}</span>
        </NavLink>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className="size-8 shrink-0 text-sidebar-foreground/60 hover:bg-sidebar-border hover:text-sidebar-foreground data-[state=open]:bg-sidebar-border data-[state=open]:text-sidebar-foreground"
              aria-label={`Conversation actions for ${label}`}
            >
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="start" className="w-40">
            <DropdownMenuItem onSelect={() => void update({ pinned: !conversation.pinned })}>
              {conversation.pinned ? <PinOff /> : <Pin />}
              {conversation.pinned ? "Unpin" : "Pin"}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                setTitle(conversation.title ?? "");
                setRenameOpen(true);
              }}
            >
              <Pencil /> Rename
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>
              <Trash2 /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename conversation</DialogTitle>
            <DialogDescription>Use a short name that is easy to scan in history.</DialogDescription>
          </DialogHeader>
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={120}
            autoFocus
            onKeyDown={(event) => {
              if (event.key === "Enter" && title.trim()) void update({ title: title.trim() });
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={busy || !title.trim()}
              onClick={() => void update({ title: title.trim() })}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete conversation?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the full message history and cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={busy} onClick={() => void remove()}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function SidebarPanel({
  collapsed,
  agents,
  history,
  pendingApprovals,
  sections,
  setSection,
  onNavigate,
  onCollapse,
  onConversationUpdate,
  onConversationDelete,
}: SidebarPanelProps) {
  const { workspace } = useSession();
  const { appearance, toggle: toggleTheme } = useTheme();
  const location = useLocation();
  const [params] = useSearchParams();
  const openConversation = location.pathname === "/chat" ? params.get("conversation") : null;

  const primary: NavItem[] = [
    { to: "/chat", label: "Chat", icon: ChatIcon, startsNewChat: true },
    { to: "/dashboards", label: "Dashboards", icon: DashboardIcon },
    {
      to: "/agents",
      label: "Agents",
      icon: AgentArtwork,
      iconClassName: "size-5 scale-[1.4]",
      contentClassName: "-translate-x-1",
    },
    { to: "/knowledge", label: "Knowledge", icon: KnowledgeIcon },
    { to: "/approvals", label: "Approvals", icon: ApprovalsIcon, badge: pendingApprovals },
    { to: "/automations", label: "Automations", icon: AutomationsIcon },
    { to: "/channels", label: "Channels", icon: ChannelsIcon },
    { to: "/settings", label: "Settings", icon: SettingsIcon },
  ];
  const planned: NavItem[] = [
    { to: "#", label: "Observability", icon: CircleGauge, planned: "P9" },
  ];
  const deployed = agents.filter((agent) => agent.status === "deployed");

  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground">
      <div
        className={cn(
          "flex h-16 shrink-0 items-center gap-2.5 border-b border-sidebar-border px-3",
          collapsed && "justify-center px-1.5",
        )}
      >
        <img src={bridgeMark} alt="Bridge" className="size-10 shrink-0 object-contain" />
        {!collapsed && (
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold leading-none">Bridge</div>
            <div className="mt-1 truncate text-[11px] text-sidebar-foreground/55">
              Agent operations
            </div>
          </div>
        )}
        {onCollapse && (
          <Button
            variant="ghost"
            size="icon-sm"
            className={cn(
              "text-sidebar-foreground/55 hover:bg-sidebar-accent",
              collapsed && "absolute left-[3.95rem] z-10 border bg-sidebar shadow-sm",
            )}
            onClick={onCollapse}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <ChevronsRight /> : <ChevronsLeft />}
          </Button>
        )}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <nav className="space-y-0.5 px-2 pb-3" aria-label="Main navigation">
          {primary.map((item) => (
            <NavigationItem
              key={item.to}
              item={item}
              collapsed={collapsed}
              onNavigate={onNavigate}
            />
          ))}
        </nav>

        {!collapsed && (
          <>
            <Separator className="mb-2" />
            <NavigationSection
              label="Deployed agents"
              open={sections.agents ?? true}
              onOpenChange={(open) => setSection("agents", open)}
            >
              {deployed.length ? (
                deployed.map((agent) => (
                  <NavLink
                    key={agent.id}
                    to={`/chat?agent=${agent.id}`}
                    onClick={onNavigate}
                    className="flex h-7 items-center gap-2 rounded-md px-2 text-sm text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                  >
                    <AgentArtwork className="size-4" />
                    <span className="truncate">{agent.name}</span>
                  </NavLink>
                ))
              ) : (
                <p className="px-2 pb-2 text-xs text-sidebar-foreground/45">No deployed agents</p>
              )}
            </NavigationSection>

            <NavigationSection
              label="Recent conversations"
              open={sections.history ?? true}
              onOpenChange={(open) => setSection("history", open)}
            >
              {history.length ? (
                history
                  .slice(0, 20)
                  .map((conversation) => (
                    <ConversationItem
                      key={conversation.id}
                      conversation={conversation}
                      active={openConversation === conversation.id}
                      workspaceId={workspace?.id ?? ""}
                      onNavigate={onNavigate}
                      onUpdate={onConversationUpdate}
                      onDelete={onConversationDelete}
                    />
                  ))
              ) : (
                <p className="px-2 pb-2 text-xs text-sidebar-foreground/45">No conversations yet</p>
              )}
            </NavigationSection>

            <NavigationSection
              label="Roadmap"
              open={sections.planned ?? false}
              onOpenChange={(open) => setSection("planned", open)}
            >
              {planned.map((item) => (
                <NavigationItem key={item.label} item={item} collapsed={false} />
              ))}
            </NavigationSection>
          </>
        )}
      </ScrollArea>

      <div
        className={cn(
          "flex shrink-0 items-center gap-2 border-t border-sidebar-border p-2",
          collapsed && "justify-center",
        )}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleTheme}
              className="text-sidebar-foreground/65 hover:bg-sidebar-accent"
              aria-label={appearance === "dark" ? "Use light theme" : "Use dark theme"}
            >
              {appearance === "dark" ? <Sun /> : <Moon />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">
            {appearance === "dark" ? "Use light theme" : "Use dark theme"}
          </TooltipContent>
        </Tooltip>
        {!collapsed && (
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium">{workspace?.name}</p>
            <p className="truncate text-[11px] text-sidebar-foreground/45">Current workspace</p>
          </div>
        )}
      </div>
    </div>
  );
}

export function Sidebar({
  mobileOpen,
  onMobileOpenChange,
}: {
  mobileOpen: boolean;
  onMobileOpenChange: (open: boolean) => void;
}) {
  const { workspace } = useSession();
  const [collapsed, setCollapsed] = useStoredFlag(COLLAPSED_KEY, false);
  const [sections, setSection] = useSections({ agents: true, history: true, planned: false });
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [history, setHistory] = useState<ConversationSummary[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState(0);

  const updateConversation = useCallback((conversation: ConversationSummary) => {
    setHistory((current) =>
      current
        .map((item) => (item.id === conversation.id ? conversation : item))
        .sort((a, b) => Number(b.pinned) - Number(a.pinned)),
    );
  }, []);
  const deleteConversation = useCallback((conversationId: string) => {
    setHistory((current) => current.filter((item) => item.id !== conversationId));
  }, []);

  useEffect(() => {
    if (!workspace) return;
    let cancelled = false;
    const poll = async () => {
      const [agentList, conversationList, approvals] = await Promise.all([
        api.agents(workspace.id).catch(() => ({ agents: [] })),
        api.conversations(workspace.id).catch(() => ({ conversations: [] })),
        api.approvals(workspace.id).catch(() => ({ approvals: [] })),
      ]);
      if (cancelled) return;
      setAgents(agentList.agents);
      setHistory(conversationList.conversations);
      setPendingApprovals(approvals.approvals.length);
    };
    void poll();
    const interval = setInterval(poll, 5_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [workspace]);

  const panelProps = {
    agents,
    history,
    pendingApprovals,
    sections,
    setSection,
    onConversationUpdate: updateConversation,
    onConversationDelete: deleteConversation,
  };

  return (
    <>
      <aside
        className={cn(
          "relative hidden h-screen shrink-0 border-r border-sidebar-border transition-[width] duration-200 md:block",
          collapsed ? "w-[4.5rem]" : "w-64",
        )}
      >
        <SidebarPanel
          {...panelProps}
          collapsed={collapsed}
          onCollapse={() => setCollapsed(!collapsed)}
        />
      </aside>

      <Sheet open={mobileOpen} onOpenChange={onMobileOpenChange}>
        <SheetContent side="left" className="w-[min(19rem,88vw)] p-0" showCloseButton={false}>
          <SheetTitle className="sr-only">Bridge navigation</SheetTitle>
          <SidebarPanel
            {...panelProps}
            collapsed={false}
            onNavigate={() => onMobileOpenChange(false)}
          />
        </SheetContent>
      </Sheet>
    </>
  );
}
