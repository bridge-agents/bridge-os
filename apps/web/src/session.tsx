import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api, type User, type Workspace } from "./api.js";

interface SessionValue {
  user: User | null;
  workspace: Workspace | null;
  workspaces: Workspace[];
  loading: boolean;
  selectWorkspace: (id: string) => void;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);
const LAST_WORKSPACE_KEY = "bridge:workspace";

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | null>(() =>
    localStorage.getItem(LAST_WORKSPACE_KEY),
  );
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [{ user: me }, { workspaces: list }] = await Promise.all([api.me(), api.workspaces()]);
      setUser(me);
      setWorkspaces(list);
      setWorkspaceId((current) =>
        current && list.some((w) => w.id === current) ? current : (list[0]?.id ?? null),
      );
    } catch {
      // Not signed in, or the session expired — both mean "show the sign-in screen".
      setUser(null);
      setWorkspaces([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selectWorkspace = useCallback((id: string) => {
    setWorkspaceId(id);
    localStorage.setItem(LAST_WORKSPACE_KEY, id);
  }, []);

  const signOut = useCallback(async () => {
    await api.logout().catch(() => {});
    setUser(null);
    setWorkspaces([]);
  }, []);

  const value = useMemo<SessionValue>(
    () => ({
      user,
      workspaces,
      workspace: workspaces.find((w) => w.id === workspaceId) ?? workspaces[0] ?? null,
      loading,
      selectWorkspace,
      refresh,
      signOut,
    }),
    [user, workspaces, workspaceId, loading, selectWorkspace, refresh, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside SessionProvider");
  return value;
}

/** The signed-in workspace, for screens that are only rendered when one exists. */
export function useWorkspaceId(): string {
  const { workspace } = useSession();
  if (!workspace) throw new Error("no workspace selected");
  return workspace.id;
}
