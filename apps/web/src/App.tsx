import { Menu, Server, ServerOff } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { api } from "./api.js";
import { Badge } from "./components/ui/badge.js";
import { Button } from "./components/ui/button.js";
import { TooltipProvider } from "./components/ui/tooltip.js";
import { cn } from "./lib/utils.js";
import { SignIn } from "./routes/SignIn.jsx";
import { Sidebar } from "./Sidebar.jsx";
import { SessionProvider, useSession } from "./session.jsx";
import { ThemeProvider } from "./theme.jsx";
import { Spinner } from "./ui.jsx";

const Chat = lazy(() => import("./routes/Chat.jsx").then((module) => ({ default: module.Chat })));
const Dashboards = lazy(() =>
  import("./routes/Dashboards.jsx").then((module) => ({ default: module.Dashboards })),
);
const Agents = lazy(() =>
  import("./routes/Agents.jsx").then((module) => ({ default: module.Agents })),
);
const AgentDetail = lazy(() =>
  import("./routes/AgentDetail.jsx").then((module) => ({ default: module.AgentDetail })),
);
const Approvals = lazy(() =>
  import("./routes/Approvals.jsx").then((module) => ({ default: module.Approvals })),
);
const Automations = lazy(() =>
  import("./routes/Automations.jsx").then((module) => ({ default: module.Automations })),
);
const Channels = lazy(() =>
  import("./routes/Channels.jsx").then((module) => ({ default: module.Channels })),
);
const Knowledge = lazy(() =>
  import("./routes/Knowledge.jsx").then((module) => ({ default: module.Knowledge })),
);
const Settings = lazy(() =>
  import("./routes/Settings.jsx").then((module) => ({ default: module.Settings })),
);

function RuntimeStatus() {
  const [health, setHealth] = useState<{ checks: { db: string } } | "offline" | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = () =>
      api
        .health()
        .then((body) => !cancelled && setHealth(body))
        .catch(() => !cancelled && setHealth("offline"));
    void poll();
    const interval = setInterval(poll, 10_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const online = health !== null && health !== "offline";
  return (
    <Badge
      variant="outline"
      className={cn(
        "hidden gap-1.5 font-normal sm:inline-flex",
        online
          ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300"
          : health === null
            ? "text-muted-foreground"
            : "border-destructive/30 bg-destructive/10 text-destructive",
      )}
    >
      {online ? <Server /> : <ServerOff />}
      {online ? "Runtime ready" : health === null ? "Connecting" : "Runtime offline"}
    </Badge>
  );
}

const PAGE_TITLES: Record<string, { title: string; description: string }> = {
  "/chat": { title: "Chat", description: "Work directly with deployed agents" },
  "/dashboards": { title: "Dashboards", description: "Operational views and live agent data" },
  "/agents": { title: "Agents", description: "Build, deploy, and inspect your workforce" },
  "/approvals": { title: "Approvals", description: "Review actions that require a human decision" },
  "/automations": {
    title: "Automations",
    description: "Schedules and triggers — work Bridge does on its own",
  },
  "/channels": { title: "Channels", description: "Connect agents to messaging platforms" },
  "/knowledge": { title: "Knowledge", description: "Durable context shared across agent runs" },
  "/settings": { title: "Settings", description: "Workspace preferences and access" },
};

function Shell() {
  const { pathname } = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const onMobileOpenChange = useCallback((open: boolean) => setMobileOpen(open), []);
  const isChat = pathname === "/chat";
  const page =
    PAGE_TITLES[pathname] ??
    (pathname.startsWith("/agents/")
      ? { title: "Agent workspace", description: "Configuration, runs, and deployment" }
      : { title: "Bridge", description: "Agent operations" });

  return (
    <TooltipProvider delayDuration={250}>
      <div className="flex h-screen overflow-hidden bg-background">
        <Sidebar mobileOpen={mobileOpen} onMobileOpenChange={onMobileOpenChange} />

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-16 shrink-0 items-center gap-3 border-b bg-background/95 px-3 backdrop-blur sm:px-5">
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden"
              onClick={() => setMobileOpen(true)}
              aria-label="Open navigation"
            >
              <Menu />
            </Button>
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-sm font-semibold">{page.title}</h1>
              <p className="hidden truncate text-xs text-muted-foreground sm:block">
                {page.description}
              </p>
            </div>
            <RuntimeStatus />
          </header>

          <main
            className={cn(
              "min-h-0 min-w-0 flex-1",
              isChat ? "overflow-hidden" : "overflow-x-hidden overflow-y-auto p-4 sm:p-6 lg:p-8",
            )}
          >
            <div className={cn("rise flex min-h-full min-w-0 w-full flex-col", isChat && "h-full")}>
              <Suspense fallback={<Spinner label={`Loading ${page.title.toLowerCase()}`} />}>
                <Routes>
                  <Route path="/chat" element={<Chat />} />
                  <Route path="/dashboards" element={<Dashboards />} />
                  <Route path="/agents" element={<Agents />} />
                  <Route path="/agents/:agentId" element={<AgentDetail />} />
                  <Route path="/approvals" element={<Approvals />} />
                  <Route path="/automations" element={<Automations />} />
                  <Route path="/channels" element={<Channels />} />
                  <Route path="/knowledge" element={<Knowledge />} />
                  <Route
                    path="/providers"
                    element={<Navigate to="/settings#providers" replace />}
                  />
                  <Route path="/settings" element={<Settings />} />
                  <Route path="*" element={<Navigate to="/chat" replace />} />
                </Routes>
              </Suspense>
            </div>
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
}

function Gate() {
  const { user, workspace, loading } = useSession();
  if (loading) return <Spinner label="Starting Bridge" />;
  if (!user || !workspace) return <SignIn />;
  return <Shell />;
}

export function App() {
  return (
    <ThemeProvider>
      <SessionProvider>
        <BrowserRouter>
          <Gate />
        </BrowserRouter>
      </SessionProvider>
    </ThemeProvider>
  );
}
