import pino, { type Logger } from "pino";

/**
 * Structured JSON logging everywhere. LOG_PRETTY=1 switches to human-readable
 * output for local development.
 */
export function createLogger(name: string): Logger {
  return pino({
    name,
    level: process.env.LOG_LEVEL ?? "info",
    transport: process.env.LOG_PRETTY === "1" ? { target: "pino-pretty" } : undefined,
  });
}

export type { Logger };
