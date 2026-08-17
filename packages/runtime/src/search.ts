import { type Db, searchConfigs } from "@bridge/db";
import { eq } from "drizzle-orm";
import type { SecretStore } from "./secrets.js";
import type { WebSearchConfig } from "./tools/native.js";

export function workspaceSearchResolver(db: Db, secretStore: SecretStore) {
  return async (workspaceId: string): Promise<WebSearchConfig | undefined> => {
    const [config] = await db
      .select()
      .from(searchConfigs)
      .where(eq(searchConfigs.workspaceId, workspaceId));
    if (!config) return undefined;
    const apiKey = config.secretId
      ? await secretStore.reveal(workspaceId, config.secretId)
      : undefined;
    return { provider: config.provider as "brave" | "custom", endpoint: config.endpoint, apiKey };
  };
}
