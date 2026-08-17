import { generateSecretKey, newWorkspaceId, parseSecretKey } from "@bridge/core";
import { createDb, type DbHandle, workspaces } from "@bridge/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EncryptedDbSecretStore, rotateEncryptedSecrets } from "./secrets.js";

let handle: DbHandle;
let workspaceId: string;

beforeEach(async () => {
  handle = await createDb("pglite:memory");
  await handle.migrate();
  workspaceId = newWorkspaceId();
  await handle.db.insert(workspaces).values({ id: workspaceId, name: "Secrets" });
});

afterEach(async () => {
  await handle.close();
});

describe("master-key rotation", () => {
  it("re-encrypts every secret without changing its plaintext", async () => {
    const oldKey = parseSecretKey(generateSecretKey());
    const nextKey = parseSecretKey(generateSecretKey());
    const oldStore = new EncryptedDbSecretStore(handle.db, oldKey);
    const secret = await oldStore.put(workspaceId, "provider-key", "top-secret-value");

    expect(await rotateEncryptedSecrets(handle.db, oldKey, nextKey)).toBe(1);
    const nextStore = new EncryptedDbSecretStore(handle.db, nextKey);
    expect(await nextStore.reveal(workspaceId, secret.id)).toBe("top-secret-value");
    await expect(oldStore.reveal(workspaceId, secret.id)).rejects.toThrow();
  });
});
