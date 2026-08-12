import type { TokenUsage } from "@bridge/sdk";

/**
 * Published list prices in USD per million tokens.
 *
 * This is a snapshot (2026-08-12), which is why unknown models return
 * `undefined` rather than a guess: a run records exactly what it spent, and a
 * missing price shows as "unknown cost" instead of a fabricated number.
 * Adding a provider's prices is a data edit, never a code change.
 */
export interface ModelPrice {
  inputPerMillion: number;
  outputPerMillion: number;
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
  // Anthropic
  "claude-fable-5": { inputPerMillion: 10, outputPerMillion: 50 },
  "claude-mythos-5": { inputPerMillion: 10, outputPerMillion: 50 },
  "claude-opus-5": { inputPerMillion: 5, outputPerMillion: 25 },
  "claude-opus-4-8": { inputPerMillion: 5, outputPerMillion: 25 },
  "claude-opus-4-7": { inputPerMillion: 5, outputPerMillion: 25 },
  "claude-opus-4-6": { inputPerMillion: 5, outputPerMillion: 25 },
  "claude-sonnet-5": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-sonnet-4-6": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-haiku-4-5": { inputPerMillion: 1, outputPerMillion: 5 },
};

export function getModelPrice(model: string): ModelPrice | undefined {
  return MODEL_PRICES[model];
}

/** Estimated USD cost, or undefined when the model has no published price here. */
export function estimateCost(model: string, usage: TokenUsage): number | undefined {
  const price = getModelPrice(model);
  if (!price) return undefined;
  return (
    (usage.inputTokens / 1_000_000) * price.inputPerMillion +
    (usage.outputTokens / 1_000_000) * price.outputPerMillion
  );
}
