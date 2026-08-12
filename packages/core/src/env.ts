import type { z } from "zod";

/**
 * Validate process.env against an app-defined schema at boot. Fails fast with
 * a readable list of problems instead of undefined behaviour later.
 */
export function loadEnv<S extends z.ZodType>(schema: S, source = process.env): z.infer<S> {
  const result = schema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment:\n${problems}`);
  }
  return result.data;
}
