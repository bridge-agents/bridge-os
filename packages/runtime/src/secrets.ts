import { decryptSecret, encryptSecret, id, maskSecret } from "@bridge/core";
import { type Db, secrets } from "@bridge/db";
import { and, eq } from "drizzle-orm";

export interface SecretRef {
  id: string;
  name: string;
  hint: string | null;
}

/**
 * Storage for credentials. The API only ever hands out {@link SecretRef}s;
 * plaintext is resolved at execution time, by the runtime, for one adapter
 * call.
 *
 * Deployment targets swap the implementation, not the callers: encrypted
 * rows here, the OS keychain on desktop, a managed KMS in Cloud (ADR-0011).
 */
export interface SecretStore {
  put(workspaceId: string, name: string, value: string): Promise<SecretRef>;
  list(workspaceId: string): Promise<SecretRef[]>;
  /** Plaintext. Callers must not log, return, or persist the result. */
  reveal(workspaceId: string, secretId: string): Promise<string | undefined>;
  delete(workspaceId: string, secretId: string): Promise<boolean>;
}

export class EncryptedDbSecretStore implements SecretStore {
  constructor(
    private readonly db: Db,
    private readonly key: Buffer,
  ) {}

  async put(workspaceId: string, name: string, value: string): Promise<SecretRef> {
    const row = {
      id: id("sec"),
      workspaceId,
      name,
      ciphertext: encryptSecret(value, this.key),
      hint: maskSecret(value),
    };
    const [saved] = await this.db
      .insert(secrets)
      .values(row)
      .onConflictDoUpdate({
        target: [secrets.workspaceId, secrets.name],
        set: { ciphertext: row.ciphertext, hint: row.hint },
      })
      .returning({ id: secrets.id, name: secrets.name, hint: secrets.hint });
    return saved ?? { id: row.id, name, hint: row.hint };
  }

  list(workspaceId: string): Promise<SecretRef[]> {
    return this.db
      .select({ id: secrets.id, name: secrets.name, hint: secrets.hint })
      .from(secrets)
      .where(eq(secrets.workspaceId, workspaceId));
  }

  async reveal(workspaceId: string, secretId: string): Promise<string | undefined> {
    const [row] = await this.db
      .select({ ciphertext: secrets.ciphertext })
      .from(secrets)
      // Scoped by workspace as well as id: a leaked id from another tenant resolves to nothing.
      .where(and(eq(secrets.id, secretId), eq(secrets.workspaceId, workspaceId)));
    return row ? decryptSecret(row.ciphertext, this.key) : undefined;
  }

  async delete(workspaceId: string, secretId: string): Promise<boolean> {
    const deleted = await this.db
      .delete(secrets)
      .where(and(eq(secrets.id, secretId), eq(secrets.workspaceId, workspaceId)))
      .returning({ id: secrets.id });
    return deleted.length > 0;
  }
}
