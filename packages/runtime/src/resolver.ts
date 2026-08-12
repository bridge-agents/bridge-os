import { BridgeError } from "@bridge/core";
import { type Db, providerConfigs } from "@bridge/db";
import { createProvider } from "@bridge/providers";
import type { Provider } from "@bridge/sdk";
import { and, eq } from "drizzle-orm";
import { EncryptedDbSecretStore } from "./secrets.js";

/**
 * Turns a workspace's stored provider configuration into a runnable adapter.
 *
 * This is the only place a credential is decrypted, and it happens per
 * execution — nothing upstream holds plaintext, and nothing downstream knows
 * where the key came from (ADR-0011). The API and the standalone worker share
 * it so there is one implementation of the credential path, not two.
 */
export function providerResolver(db: Db, secretKey: Buffer) {
  const store = new EncryptedDbSecretStore(db, secretKey);

  return async function getProvider(workspaceId: string, providerId: string): Promise<Provider> {
    const [config] = await db
      .select()
      .from(providerConfigs)
      .where(
        and(eq(providerConfigs.workspaceId, workspaceId), eq(providerConfigs.provider, providerId)),
      );
    if (!config) {
      throw new BridgeError(
        "validation_failed",
        `provider "${providerId}" is not connected in this workspace`,
      );
    }

    const apiKey = config.secretId ? await store.reveal(workspaceId, config.secretId) : undefined;

    return createProvider({
      provider: config.provider,
      apiKey,
      baseUrl: config.baseUrl ?? undefined,
    });
  };
}

/** Providers a workspace has actually connected, for pre-flight checks. */
export async function connectedProviders(db: Db, workspaceId: string): Promise<Set<string>> {
  const rows = await db
    .select({ provider: providerConfigs.provider })
    .from(providerConfigs)
    .where(eq(providerConfigs.workspaceId, workspaceId));
  return new Set(rows.map((row) => row.provider));
}
