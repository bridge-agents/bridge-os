import { z } from "zod";

/** Machine-friendly identifier: lowercase, digits, hyphens. */
export const SlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "must be lowercase letters, digits and hyphens");

/** Reference to a model, independent of any provider SDK. */
export const ModelRefSchema = z.object({
  /** Registered provider adapter id, e.g. "anthropic", "openai", "ollama". */
  provider: z.string().min(1),
  /** Provider-native model id, e.g. "claude-sonnet-5". */
  model: z.string().min(1),
});

export type ModelRef = z.infer<typeof ModelRefSchema>;
