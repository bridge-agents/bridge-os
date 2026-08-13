import bridgeIcon from "@bridge/ui/assets/bridge-icon.png";
import { useEffect, useState } from "react";
import { BrowserRouter, Navigate, NavLink, Route, Routes } from "react-router-dom";
import { api } from "./api.js";
import { AgentDetail } from "./routes/AgentDetail.jsx";
import { Agents } from "./routes/Agents.jsx";
import { Approvals } from "./routes/Approvals.jsx";
import { Chat } from "./routes/Chat.jsx";
import { Providers } from "./routes/Providers.jsx";
import { SignIn } from "./routes/SignIn.jsx";
import { SessionProvider, useSession } from "./session.jsx";
import { Spinner } from "./ui.jsx";

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
    <div className="flex items-center gap-2 font-mono text-[11px] text-text-faint">
      <span
        className={`h-1.5 w-1.5 rounded-full ${online ? "bg-success" : health === null ? "bg-warning" : "bg-danger"}`}
      />
      {online ? "runtime ready" : health === null ? "connecting" : "runtime offline"}
    </div>
  );
}

function Shell() {
  const { user, workspace, workspaces, selectWorkspace, signOut } = useSession();
  const [pendingApprovals, setPendingApprovals] = useState(0);

  // A paused agent is waiting on a person, so surface the count everywhere.
  useEffect(() => {
    if (!workspace) return;
    let cancelled = false;
    const poll = () =>
      api
        .approvals(workspace.id)
        .then(({ approvals }) => !cancelled && setPendingApprovals(approvals.length))
        .catch(() => {});
    void poll();
    const interval = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [workspace]);

  const navLink = ({ isActive }: { isActive: boolean }) =>
    `rounded-[var(--radius-sm)] px-3 py-1.5 text-sm transition ${
      isActive ? "bg-bg-overlay text-text" : "text-text-muted hover:text-text"
    }`;

  return (
    <div className="min-h-screen">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-4 px-6 py-3">
          <div className="flex items-center gap-2.5">
            <img src={bridgeIcon} alt="" className="h-7 w-7 rounded-lg" />
            <span className="text-sm font-semibold tracking-tight">Bridge</span>
          </div>

          <nav className="flex items-center gap-1">
            <NavLink to="/chat" className={navLink}>
              Chat
            </NavLink>
            <NavLink to="/agents" className={navLink}>
              Agents
            </NavLink>
            <NavLink to="/approvals" className={navLink}>
              Approvals
              {pendingApprovals > 0 && (
                <span className="ml-1.5 rounded-full bg-warning/20 px-1.5 py-0.5 font-mono text-[10px] text-warning">
                  {pendingApprovals}
                </span>
              )}
            </NavLink>
            <NavLink to="/providers" className={navLink}>
              Providers
            </NavLink>
          </nav>

          <div className="ml-auto flex items-center gap-4">
            <RuntimeStatus />
            {workspaces.length > 1 ? (
              <select
                value={workspace?.id}
                onChange={(e) => selectWorkspace(e.target.value)}
                className="rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-1 text-xs text-text-muted outline-none"
              >
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            ) : (
              <span className="text-xs text-text-muted">{workspace?.name}</span>
            )}
            <button
              type="button"
              onClick={signOut}
              className="text-xs text-text-muted underline-offset-4 hover:underline"
              title={user?.email}
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8">
        <Routes>
          <Route path="/chat" element={<Chat />} />
          <Route path="/agents" element={<Agents />} />
          <Route path="/agents/:agentId" element={<AgentDetail />} />
          <Route path="/approvals" element={<Approvals />} />
          <Route path="/providers" element={<Providers />} />
          <Route path="*" element={<Navigate to="/chat" replace />} />
        </Routes>
      </main>
    </div>
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
    <SessionProvider>
      <BrowserRouter>
        <Gate />
      </BrowserRouter>
    </SessionProvider>
  );
}
