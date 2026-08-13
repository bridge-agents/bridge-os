import { newUserId, newWorkspaceId } from "@bridge/core";
import { type Db, users, workspaceMembers, workspaces } from "@bridge/db";
import { eq } from "drizzle-orm";
import type { WorkspaceRole } from "./http.js";

/**
 * Local desktop mode: Bridge on your own machine has no accounts.
 *
 * There is nobody to authenticate *to* — the database is a file in your home
 * directory and the server listens on loopback only. So instead of asking a
 * single user to invent a password to protect data from themselves, the API
 * provisions one owner account on first boot and treats every local request
 * as that owner (ADR-0008: same product, different deployment target).
 *
 * Server and Cloud deployments never turn this on: they set
 * BRIDGE_LOCAL_MODE=0 (or simply use a non-embedded database), and the
 * ordinary signup/login path applies unchanged.
 */
export const LOCAL_EMAIL = "you@local.bridge";

export interface LocalAccount {
  userId: string;
  workspaceId: string;
}

/**
 * Find or create the local owner. Idempotent: every boot calls it, and only
 * the first one writes anything.
 */
export async function ensureLocalAccount(db: Db, name = "You"): Promise<LocalAccount> {
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, LOCAL_EMAIL));

  if (existing) {
    const [membership] = await db
      .select({ workspaceId: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, existing.id));
    // A local account always has its workspace; if it somehow lost it, fall
    // through and make a new one rather than booting into a broken state.
    if (membership) return { userId: existing.id, workspaceId: membership.workspaceId };
  }

  const userId = existing?.id ?? newUserId();
  const workspaceId = newWorkspaceId();

  if (!existing) {
    // No passwordHash: this account cannot be logged into, only used locally.
    await db.insert(users).values({ id: userId, email: LOCAL_EMAIL, name });
  }
  await db.insert(workspaces).values({ id: workspaceId, name: "My Workspace" });
  await db
    .insert(workspaceMembers)
    .values({ workspaceId, userId, role: "owner" satisfies WorkspaceRole });

  return { userId, workspaceId };
}
