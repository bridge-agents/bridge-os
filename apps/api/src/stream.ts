import { BridgeError } from "@bridge/core";
import { runSteps, runStreamEvents, runs } from "@bridge/db";
import { runBus } from "@bridge/runtime";
import { and, asc, eq, gt } from "drizzle-orm";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { requireAuth, requireWorkspace } from "./auth.js";
import type { AppDeps, AppEnv } from "./http.js";

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

/**
 * Live view of a run.
 *
 * Deltas, steps, and status all come from durable database records. That keeps
 * a separate API and worker correct without requiring Redis, and lets a late
 * client replay the complete stream in sequence.
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
      let lastStreamSeq = 0;
      let lastStatus = "";
      let closed = false;
      stream.onAbort(() => {
        closed = true;
      });

      const send = (event: string, data: unknown) =>
        stream.writeSSE({ event, data: JSON.stringify(data) });

      /** Emit anything durable that this client has not seen yet. */
      const drainDatabase = async (): Promise<string> => {
        const streamEvents = await deps.db
          .select()
          .from(runStreamEvents)
          .where(and(eq(runStreamEvents.runId, runId), gt(runStreamEvents.seq, lastStreamSeq)))
          .orderBy(asc(runStreamEvents.seq));
        for (const event of streamEvents) {
          lastStreamSeq = event.seq;
          if (event.type === "delta") await send("delta", event.data);
        }

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

      /**
       * Woken by the runtime when it shares this process, and by the clock
       * otherwise.
       *
       * Polling alone had to be fast to feel live, and fast polling on an
       * embedded database means three queries every 100ms competing with the
       * very run they are watching — the writer and the reader fighting over
       * one connection. Waiting on the bus is both quicker and quieter: text
       * appears as it is produced, and an idle stream costs one query a
       * second instead of thirty.
       */
      let wake: (() => void) | undefined;
      const unsubscribe = runBus.subscribe(runId, () => wake?.());
      const nextTick = () =>
        new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(resolve, 1000).unref?.();
        });

      try {
        await drainDatabase();

        while (!closed) {
          const status = await drainDatabase();
          // A run waiting on a human is finished as far as this stream cares —
          // the client watches the approvals queue and reconnects after deciding.
          if (TERMINAL.has(status) || status === "waiting_approval") break;

          await nextTick();
        }
      } finally {
        unsubscribe();
      }

      await send("done", { status: lastStatus });
    });
  });

  return app;
}
