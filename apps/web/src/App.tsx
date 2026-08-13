import { useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { api } from "./api.js";
import { AgentDetail } from "./routes/AgentDetail.jsx";
import { Agents } from "./routes/Agents.jsx";
import { Approvals } from "./routes/Approvals.jsx";
import { Chat } from "./routes/Chat.jsx";
import { Providers } from "./routes/Providers.jsx";
import { Settings } from "./routes/Settings.jsx";
import { SignIn } from "./routes/SignIn.jsx";
import { Sidebar } from "./Sidebar.jsx";
import { SessionProvider, useSession } from "./session.jsx";
import { ThemeProvider } from "./theme.jsx";
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
  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center justify-end border-b border-border px-6 py-2">
          <RuntimeStatus />
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto px-6 py-8">
          <div className="mx-auto max-w-4xl">
            <Routes>
              <Route path="/chat" element={<Chat />} />
              <Route path="/agents" element={<Agents />} />
              <Route path="/agents/:agentId" element={<AgentDetail />} />
              <Route path="/approvals" element={<Approvals />} />
              <Route path="/providers" element={<Providers />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="*" element={<Navigate to="/chat" replace />} />
            </Routes>
          </div>
        </main>
      </div>
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
    <ThemeProvider>
      <SessionProvider>
        <BrowserRouter>
          <Gate />
        </BrowserRouter>
      </SessionProvider>
    </ThemeProvider>
  );
}
