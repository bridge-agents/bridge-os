import {
  Copy,
  KeyRound,
  Link2,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  UserPlus,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import {
  type ApiTokenSummary,
  api,
  BridgeApiError,
  type SearchConfiguration,
  type WorkspaceInvitation,
} from "../api.js";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../components/ui/alert-dialog.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select.js";
import { Separator } from "../components/ui/separator.js";
import { useSession } from "../session.jsx";
import { ErrorText, Field, Input, SectionHeader } from "../ui.jsx";

function formatDate(value: string | null) {
  return value
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value))
    : "Never";
}

function errorMessage(cause: unknown, fallback: string) {
  return cause instanceof BridgeApiError ? cause.error.message : fallback;
}

export function AccessSettings({ isLocal }: { isLocal: boolean }) {
  const { workspace } = useSession();
  const canAdmin = workspace?.role === "owner" || workspace?.role === "admin";
  const [tokens, setTokens] = useState<ApiTokenSummary[]>([]);
  const [invitations, setInvitations] = useState<WorkspaceInvitation[]>([]);
  const [tokenName, setTokenName] = useState("");
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "member">("member");
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!workspace) return;
    const [{ tokens: nextTokens }, { invitations: nextInvitations }] = await Promise.all([
      api.apiTokens(),
      api.invitations(workspace.id),
    ]);
    setTokens(nextTokens);
    setInvitations(nextInvitations);
  }, [workspace]);

  useEffect(() => {
    void load().catch((cause) => setError(errorMessage(cause, "Could not load access settings.")));
  }, [load]);

  const createToken = async (event: FormEvent) => {
    event.preventDefault();
    if (!tokenName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const { token } = await api.createApiToken(tokenName.trim(), 90);
      setCreatedToken(token.value);
      setTokenName("");
      await load();
    } catch (cause) {
      setError(errorMessage(cause, "Could not create the API token."));
    } finally {
      setBusy(false);
    }
  };

  const invite = async (event: FormEvent) => {
    event.preventDefault();
    if (!workspace || !inviteEmail.trim()) return;
    setBusy(true);
    setError(null);
    setInviteLink(null);
    try {
      const { invitation } = await api.createInvitation(workspace.id, {
        email: inviteEmail.trim(),
        role: inviteRole,
      });
      if (invitation.token) {
        setInviteLink(`${window.location.origin}/?invite=${encodeURIComponent(invitation.token)}`);
      }
      setInviteEmail("");
      await load();
    } catch (cause) {
      setError(errorMessage(cause, "Could not create the invitation."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-4">
      <SectionHeader
        title="Access"
        description="Manage programmatic credentials and workspace invitations."
        action={<ShieldCheck className="size-7 text-muted-foreground" />}
      />
      <ErrorText>{error}</ErrorText>
      <div className="grid gap-3 xl:grid-cols-2">
        <Card className="rounded-lg">
          <CardHeader>
            <CardTitle>API tokens</CardTitle>
            <CardDescription>
              Use scoped account tokens for the Bridge CLI and API clients.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <form onSubmit={createToken} className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <Field label="Token name">
                  {(id) => (
                    <Input
                      id={id}
                      value={tokenName}
                      onChange={(event) => setTokenName(event.target.value)}
                      placeholder="Production CLI"
                      maxLength={120}
                    />
                  )}
                </Field>
              </div>
              <Button type="submit" disabled={busy || !tokenName.trim()}>
                <Plus /> Create
              </Button>
            </form>
            {createdToken && (
              <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50/50 p-3 dark:border-amber-900 dark:bg-amber-950/20">
                <p className="text-sm font-medium">
                  Copy this token now. It will not be shown again.
                </p>
                <div className="flex gap-2">
                  <code className="min-w-0 flex-1 overflow-hidden text-ellipsis rounded bg-background px-2 py-1.5 text-xs">
                    {createdToken}
                  </code>
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    aria-label="Copy API token"
                    title="Copy API token"
                    onClick={() => void navigator.clipboard.writeText(createdToken)}
                  >
                    <Copy />
                  </Button>
                </div>
              </div>
            )}
            <div className="divide-y">
              {tokens.length === 0 && (
                <p className="py-3 text-sm text-muted-foreground">No active tokens.</p>
              )}
              {tokens.map((token) => (
                <div key={token.id} className="flex items-center gap-3 py-3">
                  <KeyRound className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{token.name}</p>
                    <p className="text-xs text-muted-foreground">
                      Expires {formatDate(token.expiresAt)} · Last used{" "}
                      {formatDate(token.lastUsedAt)}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={`Revoke ${token.name}`}
                    title="Revoke token"
                    onClick={() =>
                      void api
                        .revokeApiToken(token.id)
                        .then(load)
                        .catch((cause) =>
                          setError(errorMessage(cause, "Could not revoke the token.")),
                        )
                    }
                  >
                    <Trash2 />
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-lg">
          <CardHeader>
            <CardTitle>Workspace invitations</CardTitle>
            <CardDescription>
              Invite a colleague by email or create a secure share link.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <form
              onSubmit={invite}
              className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_8rem_auto] sm:items-end"
            >
              <Field label="Email">
                {(id) => (
                  <Input
                    id={id}
                    type="email"
                    value={inviteEmail}
                    onChange={(event) => setInviteEmail(event.target.value)}
                    placeholder="teammate@company.com"
                    disabled={!canAdmin}
                    required
                  />
                )}
              </Field>
              <Field label="Role">
                {() => (
                  <Select
                    value={inviteRole}
                    onValueChange={(value) => setInviteRole(value as "admin" | "member")}
                    disabled={!canAdmin}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="member">Member</SelectItem>
                      <SelectItem value="admin">Admin</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              </Field>
              <Button type="submit" disabled={!canAdmin || busy || !inviteEmail.trim()}>
                <UserPlus /> Invite
              </Button>
            </form>
            {inviteLink && (
              <div className="flex items-center gap-2 rounded-md border bg-muted/30 p-2">
                <Link2 className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-xs">{inviteLink}</span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void navigator.clipboard.writeText(inviteLink)}
                >
                  <Copy /> Copy
                </Button>
              </div>
            )}
            <div className="divide-y">
              {invitations.length === 0 && (
                <p className="py-3 text-sm text-muted-foreground">No active invitations.</p>
              )}
              {invitations.map((invitation) => (
                <div key={invitation.id} className="flex items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{invitation.email}</p>
                    <p className="text-xs text-muted-foreground">
                      {invitation.role} · Expires {formatDate(invitation.expiresAt)}
                    </p>
                  </div>
                  {invitation.acceptedAt ? (
                    <Badge variant="secondary">Accepted</Badge>
                  ) : (
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      disabled={!canAdmin}
                      aria-label={`Revoke invitation for ${invitation.email}`}
                      title="Revoke invitation"
                      onClick={() =>
                        workspace &&
                        void api
                          .revokeInvitation(workspace.id, invitation.id)
                          .then(load)
                          .catch((cause) =>
                            setError(errorMessage(cause, "Could not revoke the invitation.")),
                          )
                      }
                    >
                      <Trash2 />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {isLocal && (
        <Card className="rounded-lg">
          <CardHeader>
            <CardTitle>Master key</CardTitle>
            <CardDescription>
              Re-encrypt all saved provider and workspace secrets with a new OS-stored key.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button type="button" variant="outline">
                  <RefreshCw /> Rotate master key
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Rotate the local master key?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Bridge will re-encrypt every stored secret. Keep the application running until
                    this completes.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() =>
                      void api
                        .rotateSecretKey()
                        .catch((cause) =>
                          setError(errorMessage(cause, "Could not rotate the master key.")),
                        )
                    }
                  >
                    Rotate key
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </CardContent>
        </Card>
      )}
    </section>
  );
}

export function SearchSettings() {
  const { workspace } = useSession();
  const canAdmin = workspace?.role === "owner" || workspace?.role === "admin";
  const [saved, setSaved] = useState<SearchConfiguration | null>(null);
  const [provider, setProvider] = useState<"brave" | "custom">("brave");
  const [endpoint, setEndpoint] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!workspace) return;
    const { search } = await api.searchConfiguration(workspace.id);
    setSaved(search);
    if (search) {
      setProvider(search.provider);
      setEndpoint(search.provider === "custom" ? search.endpoint : "");
    }
  }, [workspace]);

  useEffect(() => {
    void load().catch((cause) => setError(errorMessage(cause, "Could not load search settings.")));
  }, [load]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!workspace) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateSearchConfiguration(workspace.id, {
        provider,
        ...(provider === "custom" ? { endpoint: endpoint.trim() } : {}),
        ...(apiKey ? { apiKey } : {}),
      });
      setApiKey("");
      await load();
    } catch (cause) {
      setError(errorMessage(cause, "Could not save web search settings."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-4">
      <SectionHeader
        title="Web search"
        description="Configure the search provider available to agents with the web-search tool."
        action={<Search className="size-7 text-muted-foreground" />}
      />
      <Card className="rounded-lg">
        <CardContent>
          <form
            onSubmit={submit}
            className="grid gap-4 lg:grid-cols-[12rem_minmax(16rem,1fr)_minmax(16rem,1fr)_auto] lg:items-end"
          >
            <Field label="Provider">
              {() => (
                <Select
                  value={provider}
                  onValueChange={(value) => setProvider(value as "brave" | "custom")}
                  disabled={!canAdmin}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="brave">Brave Search</SelectItem>
                    <SelectItem value="custom">Custom endpoint</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </Field>
            {provider === "custom" ? (
              <Field label="Endpoint">
                {(id) => (
                  <Input
                    id={id}
                    type="url"
                    value={endpoint}
                    onChange={(event) => setEndpoint(event.target.value)}
                    placeholder="https://search.company.com/api"
                    disabled={!canAdmin}
                    required
                  />
                )}
              </Field>
            ) : (
              <div className="hidden lg:block" />
            )}
            <Field
              label={saved?.apiKeyHint ? `API key (${saved.apiKeyHint})` : "API key"}
              hint={saved?.apiKeyHint ? "Leave blank to keep it." : undefined}
            >
              {(id) => (
                <Input
                  id={id}
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={saved?.apiKeyHint ? "Unchanged" : "Enter API key"}
                  disabled={!canAdmin}
                />
              )}
            </Field>
            <div className="flex gap-2">
              <Button
                type="submit"
                disabled={
                  !canAdmin || busy || (!saved?.apiKeyHint && provider === "brave" && !apiKey)
                }
              >
                {busy ? "Saving" : "Save search"}
              </Button>
              {saved && (
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label="Remove web search configuration"
                  title="Remove search configuration"
                  disabled={!canAdmin || busy}
                  onClick={() =>
                    workspace &&
                    void api
                      .deleteSearchConfiguration(workspace.id)
                      .then(() => {
                        setSaved(null);
                        setApiKey("");
                      })
                      .catch((cause) =>
                        setError(errorMessage(cause, "Could not remove search settings.")),
                      )
                  }
                >
                  <Trash2 />
                </Button>
              )}
            </div>
          </form>
          {saved && (
            <>
              <Separator className="my-4" />
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <Badge variant="secondary">Configured</Badge>
                <span>{saved.provider === "brave" ? "Brave Search" : saved.endpoint}</span>
              </div>
            </>
          )}
          <ErrorText>{error}</ErrorText>
        </CardContent>
      </Card>
    </section>
  );
}
