import bridgeMark from "@bridge/ui/assets/bridge-icon-transparent.png";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { NavLink, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { type AgentSummary, api, type ConversationSummary } from "./api.js";
import {
  AgentsIcon,
  ApprovalsIcon,
  AutomationIcon,
  ChannelsIcon,
  ChatIcon,
  ChevronIcon,
  DashboardIcon,
  KnowledgeIcon,
  MoonIcon,
  ObservabilityIcon,
  OptimizerIcon,
  PlusIcon,
  ProvidersIcon,
  SettingsIcon,
  SidebarIcon,
  SunIcon,
} from "./icons.jsx";
import { useSession } from "./session.jsx";
import { useTheme } from "./theme.jsx";

/**
 * The application shell's navigation.
 *
 * Sections that grow without bound (agents, chat history) collapse
 * independently and remember their state, and the whole rail collapses to
 * icons. Pages the roadmap has promised but that do not exist yet are listed
 * and visibly disabled: a nav that hides the shape of the product teaches
 * nothing, and a nav that links to nothing is worse.
 */
const COLLAPSED_KEY = "bridge:sidebar-collapsed";
const SECTIONS_KEY = "bridge:sidebar-sections";

interface NavItem {
  to: string;
  label: string;
  icon: (props: { className?: string }) => ReactNode;
  /** Roadmap phase this arrives in; present means "not built yet". */
  planned?: string;
  badge?: number;
}

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

/** Collapsible section state, all sections in one record. */
function useSections(initial: Record<string, boolean>) {
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    try {
      return { ...initial, ...JSON.parse(localStorage.getItem(SECTIONS_KEY) ?? "{}") };
    } catch {
      return initial;
    }
  });

  const toggle = useCallback((key: string) => {
    setOpen((current) => {
      const next = { ...current, [key]: !current[key] };
      localStorage.setItem(SECTIONS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  // A section never seen before reads as closed rather than undefined.
  const isOpen = useCallback((key: string) => open[key] ?? false, [open]);
  return [isOpen, toggle] as const;
}

function ItemLink({ item, collapsed }: { item: NavItem; collapsed: boolean }) {
  const Icon = item.icon;
  const label = item.planned ? `${item.label} — coming in ${item.planned}` : item.label;

  if (item.planned) {
    return (
      <span
        title={label}
        aria-disabled="true"
        className="flex cursor-not-allowed items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 py-1.5 text-sm text-text-faint"
      >
        <Icon />
        {!collapsed && (
          <>
            <span className="truncate">{item.label}</span>
            <span className="ml-auto rounded-[var(--radius-sm)] border border-border px-1.5 font-mono text-[10px] leading-4 text-text-faint">
              soon
            </span>
          </>
        )}
      </span>
    );
  }

  return (
    <NavLink
      to={item.to}
      title={collapsed ? item.label : undefined}
      className={({ isActive }) =>
        `relative flex items-center gap-2.5 rounded-[var(--radius-sm)] py-1.5 text-sm transition ${
          collapsed ? "justify-center px-0" : "px-2.5"
        } ${
          isActive
            ? "bg-bg-overlay text-text before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[2px] before:rounded-full before:bg-accent"
            : "text-text-muted hover:bg-bg-overlay/60 hover:text-text"
        }`
      }
    >
      <Icon />
      {!collapsed && (
        <>
          <span className="truncate">{item.label}</span>
          {item.badge ? (
            <span className="ml-auto rounded-[var(--radius-sm)] border border-warning/40 px-1.5 font-mono text-[10px] leading-4 text-warning">
              {item.badge}
            </span>
          ) : null}
        </>
      )}
    </NavLink>
  );
}

function Section({
  id,
  title,
  open,
  onToggle,
  action,
  children,
}: {
  id: string;
  title: string;
  open: boolean;
  onToggle: () => void;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1 pr-1">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={`${id}-items`}
          className="flex flex-1 items-center gap-1.5 rounded-[var(--radius-sm)] px-2.5 py-1 font-condensed text-[11px] font-semibold uppercase tracking-[0.1em] text-text-faint transition hover:text-text-muted"
        >
          <ChevronIcon className={`h-3 w-3 transition-transform ${open ? "rotate-90" : ""}`} />
          {title}
          <span className="dimension ml-1" aria-hidden="true" />
        </button>
        {action}
      </div>
      {open && (
        <div id={`${id}-items`} className="flex flex-col gap-0.5 pb-1">
          {children}
        </div>
      )}
    </div>
  );
}

export function Sidebar() {
  const { workspace } = useSession();
  const { appearance, toggle: toggleTheme } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();

  /*
   * NavLink's own active state ignores the query string, which would light up
   * every conversation at once — the thread *is* the query here, so selection
   * has to be computed from it.
   */
  const onChat = location.pathname === "/chat";
  const openConversation = onChat ? params.get("conversation") : null;
  const openAgent = onChat ? params.get("agent") : null;

  const [collapsed, setCollapsed] = useStoredFlag(COLLAPSED_KEY, false);
  const [sectionOpen, toggleSection] = useSections({ agents: true, history: true });

  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [history, setHistory] = useState<ConversationSummary[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState(0);

  // The sidebar reflects live state: a new chat, a deployed agent, or an agent
  // pausing for approval should all appear without a reload.
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
    const interval = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [workspace]);

  const primary: NavItem[] = [
    { to: "/chat", label: "Chat", icon: ChatIcon },
    { to: "/dashboards", label: "Dashboards", icon: DashboardIcon },
    { to: "/agents", label: "Agents", icon: AgentsIcon },
    { to: "/approvals", label: "Approvals", icon: ApprovalsIcon, badge: pendingApprovals },
    { to: "/providers", label: "Providers", icon: ProvidersIcon },
    { to: "/settings", label: "Settings", icon: SettingsIcon },
  ];

  const planned: NavItem[] = [
    { to: "#", label: "Channels", icon: ChannelsIcon, planned: "Phase 7" },
    { to: "#", label: "Automations", icon: AutomationIcon, planned: "Phase 8" },
    { to: "#", label: "Observability", icon: ObservabilityIcon, planned: "Phase 9" },
    { to: "#", label: "Knowledge", icon: KnowledgeIcon, planned: "Phase 9" },
    { to: "#", label: "Optimizer", icon: OptimizerIcon, planned: "Phase 10" },
  ];

  const deployed = agents.filter((agent) => agent.status === "deployed");

  return (
    <aside
      className="flex shrink-0 flex-col border-r border-border bg-bg-raised transition-[width] duration-200"
      style={{
        width: collapsed ? "var(--bridge-sidebar-collapsed)" : "var(--bridge-sidebar-width)",
      }}
    >
      {/*
        Collapsed, the mark and the toggle stack: side by side they are wider
        than the rail and spill over the border into the page.
      */}
      <div
        className={`flex px-2 py-3 ${collapsed ? "flex-col items-center gap-2" : "items-center gap-2 px-3"}`}
      >
        {/* Square, not a circle: the mark is a bridge silhouette, and cropping
            it to a round avatar cuts the deck off at both ends. */}
        <img src={bridgeMark} alt="Bridge" className="h-9 w-9 shrink-0 object-contain" />
        {!collapsed && (
          <span className="font-condensed text-base font-semibold uppercase tracking-[0.14em]">
            Bridge
          </span>
        )}
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className={`rounded-[var(--radius-sm)] p-1 text-text-faint transition hover:bg-bg-overlay hover:text-text ${
            collapsed ? "" : "ml-auto"
          }`}
        >
          <SidebarIcon />
        </button>
      </div>

      <div className="flex flex-col gap-1 px-2 pb-2">
        <button
          type="button"
          onClick={() => navigate("/chat")}
          title="New chat"
          className={`flex items-center gap-2.5 rounded-[var(--radius-sm)] border border-border py-1.5 text-sm text-text transition hover:border-border-strong hover:bg-bg-overlay ${
            collapsed ? "justify-center px-0" : "px-2.5"
          }`}
        >
          <PlusIcon />
          {!collapsed && <span>New chat</span>}
        </button>
        <button
          type="button"
          onClick={() => navigate("/agents")}
          title="New agent"
          className={`flex items-center gap-2.5 rounded-[var(--radius-sm)] py-1.5 text-sm text-text-muted transition hover:bg-bg-overlay hover:text-text ${
            collapsed ? "justify-center px-0" : "px-2.5"
          }`}
        >
          <AgentsIcon />
          {!collapsed && <span>New agent</span>}
        </button>
      </div>

      <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 pb-2">
        <div className="flex flex-col gap-0.5">
          {primary.map((item) => (
            <ItemLink key={item.label} item={item} collapsed={collapsed} />
          ))}
        </div>

        {!collapsed && (
          <>
            <Section
              id="agents"
              title="Agents"
              open={sectionOpen("agents")}
              onToggle={() => toggleSection("agents")}
            >
              {deployed.length === 0 ? (
                <p className="px-2.5 py-1 text-xs text-text-faint">No deployed agents</p>
              ) : (
                deployed.map((agent) => (
                  <NavLink
                    key={agent.id}
                    to={`/chat?agent=${agent.id}`}
                    className={`relative flex items-center gap-2 rounded-[var(--radius-sm)] px-2.5 py-1.5 text-sm transition ${
                      openAgent === agent.id && !openConversation
                        ? "bg-bg-overlay text-text before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[2px] before:rounded-full before:bg-accent"
                        : "text-text-muted hover:bg-bg-overlay/60 hover:text-text"
                    }`}
                  >
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
                    <span className="truncate">{agent.name}</span>
                  </NavLink>
                ))
              )}
            </Section>

            <Section
              id="history"
              title="Chat history"
              open={sectionOpen("history")}
              onToggle={() => toggleSection("history")}
            >
              {history.length === 0 ? (
                <p className="px-2.5 py-1 text-xs text-text-faint">Nothing yet</p>
              ) : (
                history.slice(0, 25).map((thread) => (
                  <NavLink
                    key={thread.id}
                    to={`/chat?agent=${thread.agentId}&conversation=${thread.id}`}
                    className={`relative truncate rounded-[var(--radius-sm)] px-2.5 py-1.5 text-sm transition ${
                      openConversation === thread.id
                        ? "bg-bg-overlay text-text before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[2px] before:rounded-full before:bg-accent"
                        : "text-text-muted hover:bg-bg-overlay/60 hover:text-text"
                    }`}
                    title={thread.title ?? thread.agentName}
                  >
                    {thread.title ?? `${thread.agentName} conversation`}
                  </NavLink>
                ))
              )}
            </Section>

            <Section
              id="planned"
              title="Planned"
              open={sectionOpen("planned")}
              onToggle={() => toggleSection("planned")}
            >
              {planned.map((item) => (
                <ItemLink key={item.label} item={item} collapsed={collapsed} />
              ))}
            </Section>
          </>
        )}
      </nav>

      <div
        className={`mt-auto flex items-center gap-2 border-t border-border py-2 ${
          collapsed ? "justify-center px-2" : "px-3"
        }`}
      >
        <button
          type="button"
          onClick={toggleTheme}
          title={appearance === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          aria-label={appearance === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          className="rounded-[var(--radius-sm)] p-1.5 text-text-faint transition hover:bg-bg-overlay hover:text-text"
        >
          {appearance === "dark" ? <SunIcon /> : <MoonIcon />}
        </button>
        {!collapsed && (
          <span className="truncate font-condensed text-[11px] uppercase tracking-[0.1em] text-text-faint">
            {workspace?.name}
          </span>
        )}
      </div>
    </aside>
  );
}
