import bridgeIcon from "@bridge/ui/assets/bridge-icon.png";
import { useEffect, useState } from "react";

interface Health {
  status: string;
  version: string;
  checks: { db: string };
}

export function App() {
  const [health, setHealth] = useState<Health | null | "offline">(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch("/api/health");
        const body = (await res.json()) as Health;
        if (!cancelled) setHealth(body);
      } catch {
        if (!cancelled) setHealth("offline");
      }
    };
    poll();
    const interval = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const online = health !== null && health !== "offline";

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8">
      <img src={bridgeIcon} alt="Bridge" className="h-28 w-28 rounded-3xl shadow-2xl" />
      <div className="flex flex-col items-center gap-1">
        <h1 className="text-3xl font-semibold tracking-tight">Bridge</h1>
        <p className="text-sm text-text-muted">Agent OS</p>
      </div>
      <div className="flex items-center gap-4 rounded-md border border-border bg-bg-raised px-4 py-2 font-mono text-xs">
        <span className="flex items-center gap-2">
          <span
            className={`h-2 w-2 rounded-full ${online ? "bg-success" : health === null ? "bg-warning" : "bg-danger"}`}
          />
          {health === null ? "connecting…" : online ? "api online" : "api offline"}
        </span>
        {online && <span className="text-text-faint">db: {health.checks.db}</span>}
        {online && <span className="text-text-faint">v{health.version}</span>}
      </div>
    </main>
  );
}
