import { BullMqQueue } from "./bullmq-queue.js";
import { LocalQueue } from "./local-queue.js";
import type { JobQueue, QueueOptions } from "./types.js";

export { BullMqQueue } from "./bullmq-queue.js";
export { LocalQueue } from "./local-queue.js";
export type { Job, JobHandler, JobQueue, QueueOptions } from "./types.js";

/**
 * Select a queue driver from configuration. `redis://…` uses BullMQ; anything
 * else (including no REDIS_URL at all) runs in-process, which is what the
 * desktop local runtime does.
 */
export function createQueue(redisUrl: string | undefined, options: QueueOptions): JobQueue {
  return redisUrl?.startsWith("redis://") || redisUrl?.startsWith("rediss://")
    ? new BullMqQueue(redisUrl, options)
    : new LocalQueue(options);
}
