import { type Db, providerConfigs } from "@bridge/db";
import { and, eq } from "drizzle-orm";
import type { SecretStore } from "./secrets.js";
import type { ImageConfig } from "./tools/native.js";

/**
 * Image generation borrows a connected provider rather than asking for its
 * own credentials: whoever connected OpenAI to answer questions can already
 * draw, and one more key to paste is one more reason nothing works.
 *
 * Only OpenAI-shaped endpoints are tried, because `/images/generations` is
 * the only image API in the wire format Bridge speaks.
 */
const IMAGE_CAPABLE = ["openai", "azure-openai", "openai-compatible"] as const;

const DEFAULT_ENDPOINT: Record<string, string> = {
  openai: "https://api.openai.com/v1",
};

export function workspaceImageResolver(db: Db, secretStore: SecretStore) {
  return async (workspaceId: string): Promise<ImageConfig | undefined> => {
    for (const provider of IMAGE_CAPABLE) {
      const [config] = await db
        .select()
        .from(providerConfigs)
        .where(
          and(eq(providerConfigs.workspaceId, workspaceId), eq(providerConfigs.provider, provider)),
        );
      if (!config) continue;

      const endpoint = config.baseUrl ?? DEFAULT_ENDPOINT[provider];
      if (!endpoint) continue;
      const apiKey = config.secretId
        ? await secretStore.reveal(workspaceId, config.secretId)
        : undefined;
      if (!apiKey) continue;

      return { endpoint, apiKey };
    }
    return undefined;
  };
}
