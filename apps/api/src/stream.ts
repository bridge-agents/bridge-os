import { BridgeError } from "@bridge/core";
import { runSteps, runs } from "@bridge/db";
import { type RunEvent, runBus } from "@bridge/runtime";
import { and, asc, eq, gt } from "drizzle-orm";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { requireAuth, requireWorkspace } from "./auth.js";
import type { AppDeps, AppEnv } from "./http.js";

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

/**
 * Live view of a run.
 *
 * Two sources, deliberately: the in-process bus carries token deltas the
 * instant they arrive, and a database poll picks up steps and status changes
 * even when the executor is a *different process* (a server deployment).
 * Steps are de-duplicated by sequence number, so a client sees each exactly
 * once regardless of which source delivered it — and a client that connects
 * late still gets everything, because the database is the durable record.
 */
export function streamRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  app.use("*", requireAuth(deps), requireWorkspace(deps));

  app.get("/runs/:runId/stream", async (c) => {
    const workspaceId = c.get("workspaceId");
    const runId = c.req.param("runId");

    const [run] = await deps.db
      .select()
      .from(runs)
      .where(and(eq(runs.workspaceId, workspaceId), eq(runs.id, runId)));
    if (!run) throw new BridgeError("not_found", "run not found");

    return streamSSE(c, async (stream) => {
      let lastSeq = -1;
      let lastStatus = "";
      let closed = false;
      const queue: RunEvent[] = [];

      const unsubscribe = runBus.subscribe(runId, (event) => queue.push(event));
      stream.onAbort(() => {
        closed = true;
        unsubscribe();
      });

      const send = (event: string, data: unknown) =>
        stream.writeSSE({ event, data: JSON.stringify(data) });

      /** Emit anything durable that this client has not seen yet. */
      const drainDatabase = async (): Promise<string> => {
        const steps = await deps.db
          .select()
          .from(runSteps)
          .where(and(eq(runSteps.runId, runId), gt(runSteps.seq, lastSeq)))
          .orderBy(asc(runSteps.seq));

        for (const step of steps) {
          lastSeq = step.seq;
          await send("step", {
            seq: step.seq,
            type: step.type,
            agentName: step.agentName,
            data: step.data,
          });
        }

        const [current] = await deps.db
          .select({ status: runs.status, output: runs.output, error: runs.error })
          .from(runs)
          .where(eq(runs.id, runId));
        const status = current?.status ?? "unknown";

        if (status !== lastStatus) {
          lastStatus = status;
          await send("status", { status, output: current?.output, error: current?.error });
        }
        return status;
      };

      await drainDatabase();

      while (!closed) {
        // Deltas first: they are the part that has to feel immediate.
        while (queue.length > 0) {
          const event = queue.shift();
          if (event?.type === "delta") {
            await send("delta", { agentName: event.agentName, text: event.text });
          }
        }

        const status = await drainDatabase();
        // A run waiting on a human is finished as far as this stream cares —
        // the client watches the approvals queue and reconnects after deciding.
        if (TERMINAL.has(status) || status === "waiting_approval") break;

        await new Promise((resolve) => setTimeout(resolve, 250));
      }

      unsubscribe();
      await send("done", { status: lastStatus });
    });
  });

  return app;
}
