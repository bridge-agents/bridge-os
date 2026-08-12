import { describe, expect, it } from "vitest";
import { createQueue, LocalQueue } from "./index.js";
import type { Job } from "./types.js";

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("createQueue driver selection", () => {
  it("uses the in-process driver when no Redis is configured (desktop local runtime)", () => {
    expect(createQueue(undefined, { name: "t" }).driver).toBe("local");
    expect(createQueue("", { name: "t" }).driver).toBe("local");
  });

  it("uses BullMQ when a Redis URL is configured", () => {
    const queue = createQueue("redis://localhost:6379", { name: "t" });
    expect(queue.driver).toBe("bullmq");
    void queue.close();
  });
});

describe("LocalQueue", () => {
  it("processes enqueued jobs", async () => {
    const seen: Job[] = [];
    const queue = new LocalQueue({ name: "t" });
    queue.process(async (job) => {
      seen.push(job);
    });

    await queue.enqueue("run", { id: "run_1" });
    await queue.enqueue("run", { id: "run_2" });
    await settle();

    expect(seen.map((j) => j.data.id)).toEqual(["run_1", "run_2"]);
    await queue.close();
  });

  it("respects the concurrency cap", async () => {
    let active = 0;
    let peak = 0;
    const queue = new LocalQueue({ name: "t", concurrency: 2 });
    queue.process(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    });

    for (let i = 0; i < 6; i++) await queue.enqueue("job");
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(peak).toBe(2);
    await queue.close();
  });

  it("reports failures instead of swallowing them", async () => {
    const failures: unknown[] = [];
    const queue = new LocalQueue({ name: "t", onFailed: (_job, error) => failures.push(error) });
    queue.process(async () => {
      throw new Error("boom");
    });

    await queue.enqueue("job");
    await settle();

    expect(failures).toHaveLength(1);
    await queue.close();
  });

  it("keeps the process alive while work is scheduled", async () => {
    const queue = new LocalQueue({ name: "t" });
    queue.process(async () => {});
    await queue.schedule("tick", 1000);

    // An unreferenced timer would let a desktop worker exit the moment it started.
    const timer = (queue as unknown as { timers: Map<string, NodeJS.Timeout> }).timers.get("tick");
    expect(timer?.hasRef()).toBe(true);
    await queue.close();
  });

  it("stops scheduled work on close", async () => {
    let runs = 0;
    const queue = new LocalQueue({ name: "t" });
    queue.process(async () => {
      runs += 1;
    });

    await queue.schedule("tick", 5);
    await settle();
    await queue.close();
    const afterClose = runs;
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(runs).toBe(afterClose);
  });
});
