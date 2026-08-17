import {
  Check,
  CloudCog,
  ExternalLink,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  PlugZap,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  api,
  BridgeApiError,
  type CliAuthStatus,
  type CliProviderId,
  type ProviderConfig,
  type SecretRef,
} from "../api.js";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card.js";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs.js";
import { ProviderLogo } from "../ProviderLogo.jsx";
import { providerCatalogEntry, providerName } from "../providerCatalog.js";
import { useWorkspaceId } from "../session.jsx";
import { EmptyState, ErrorText, Field, Input, SectionHeader, Spinner } from "../ui.jsx";

const CLI_PROVIDER_IDS: CliProviderId[] = ["codex", "claude-code", "github-copilot"];
const CLI_PLAN_INFO: Record<CliProviderId, { description: string; action: string }> = {
  codex: {
    description: "Use your ChatGPT plan through the Codex CLI.",
    action: "Sign in with ChatGPT",
  },
  "claude-code": {
    description: "Use your Claude plan through Claude Code.",
    action: "Sign in with Claude",
  },
  "github-copilot": {
    description: "Use your GitHub Copilot plan through the Copilot CLI.",
    action: "Sign in with GitHub",
  },
};

export function ProviderSettings() {
  const workspaceId = useWorkspaceId();
  const [connected, setConnected] = useState<ProviderConfig[] | null>(null);
  const [available, setAvailable] = useState<string[]>([]);
  const [provider, setProvider] = useState("anthropic");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cliStatus, setCliStatus] = useState<Record<CliProviderId, CliAuthStatus> | null>(null);
  const [authPending, setAuthPending] = useState<CliProviderId | null>(null);
  const [authCommand, setAuthCommand] = useState<string | null>(null);
  const [secrets, setSecrets] = useState<SecretRef[]>([]);
  const [secretName, setSecretName] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const [secretError, setSecretError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [{ providers }, { providers: list }, { secrets: stored }] = await Promise.all([
        api.providers(workspaceId),
        api.availableProviders(workspaceId),
        api.secrets(workspaceId),
      ]);
      setConnected(providers);
      setAvailable(list);
      setSecrets(stored);
      const firstApiProvider = list.find(
        (name) => !CLI_PROVIDER_IDS.includes(name as (typeof CLI_PROVIDER_IDS)[number]),
      );
      setProvider((current) =>
        firstApiProvider && !list.includes(current) ? firstApiProvider : current,
      );
    } catch (cause) {
      setConnected([]);
      setError(
        cause instanceof BridgeApiError ? cause.error.message : "Could not load provider settings.",
      );
    }

    void api
      .cliProviderStatus(workspaceId)
      .then(({ providers }) => setCliStatus(providers))
      .catch(() => setCliStatus(null));
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!authPending) return;
    const interval = setInterval(() => {
      void api.cliProviderStatus(workspaceId).then(async ({ providers: statuses }) => {
        setCliStatus(statuses);
        if (!statuses[authPending].loggedIn) return;
        await api.finishProviderOAuth(workspaceId, authPending);
        setAuthPending(null);
        setAuthCommand(null);
        await load();
      });
    }, 2_000);
    return () => clearInterval(interval);
  }, [workspaceId, authPending, load]);

  const selectedProvider = providerCatalogEntry(provider);
  const endpointOnly = selectedProvider.needsBaseUrl === true;
  const showBaseUrl = endpointOnly || selectedProvider.supportsBaseUrl === true;
  const apiProviders = available.filter(
    (name) => !CLI_PROVIDER_IDS.includes(name as (typeof CLI_PROVIDER_IDS)[number]),
  );

  const startOAuth = async (id: CliProviderId) => {
    setError(null);
    setAuthPending(id);
    try {
      const result = await api.startProviderOAuth(workspaceId, id);
      if (result.connected) {
        setAuthPending(null);
        await load();
      } else {
        setAuthCommand(result.command ?? null);
      }
    } catch (cause) {
      setAuthPending(null);
      setError(cause instanceof BridgeApiError ? cause.error.message : "Could not start sign-in.");
    }
  };

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.connectProvider(workspaceId, {
        provider,
        apiKey: endpointOnly ? undefined : apiKey,
        baseUrl: showBaseUrl ? baseUrl || undefined : undefined,
      });
      setApiKey("");
      setBaseUrl("");
      await load();
    } catch (cause) {
      setError(
        cause instanceof BridgeApiError ? cause.error.message : "Could not connect this provider.",
      );
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async (name: string) => {
    await api.disconnectProvider(workspaceId, name);
    await load();
  };

  const saveSecret = async () => {
    setSecretError(null);
    try {
      await api.putSecret(workspaceId, secretName, secretValue);
      setSecretName("");
      setSecretValue("");
      await load();
    } catch (cause) {
      setSecretError(
        cause instanceof BridgeApiError ? cause.error.message : "Could not save the secret.",
      );
    }
  };

  if (!connected) return <Spinner label="Loading providers" />;
  const subscriptionCount = connected.filter((entry) => entry.authType === "oauth-cli").length;

  return (
    <div className="flex w-full flex-col gap-6">
      <div className="grid gap-3 sm:grid-cols-3">
        <Card className="rounded-lg">
          <CardContent className="flex items-center gap-3 py-1">
            <span className="flex size-9 items-center justify-center rounded-lg bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
              <PlugZap className="size-4" />
            </span>
            <div>
              <p className="text-xl font-semibold">{connected.length}</p>
              <p className="text-xs text-muted-foreground">Connected providers</p>
            </div>
          </CardContent>
        </Card>
        <Card className="rounded-lg">
          <CardContent className="flex items-center gap-3 py-1">
            <span className="flex size-9 items-center justify-center rounded-lg bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300">
              <CloudCog className="size-4" />
            </span>
            <div>
              <p className="text-xl font-semibold">{subscriptionCount}</p>
              <p className="text-xs text-muted-foreground">Plan connections</p>
            </div>
          </CardContent>
        </Card>
        <Card className="rounded-lg">
          <CardContent className="flex items-center gap-3 py-1">
            <span className="flex size-9 items-center justify-center rounded-lg bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
              <LockKeyhole className="size-4" />
            </span>
            <div>
              <p className="text-xl font-semibold">{secrets.length}</p>
              <p className="text-xs text-muted-foreground">Workspace secrets</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <ErrorText>{error}</ErrorText>

      <Tabs defaultValue="subscriptions" className="w-full">
        <TabsList size="comfortable" className="flex w-full justify-start overflow-x-auto sm:w-fit">
          <TabsTrigger value="subscriptions">
            <CloudCog /> Plans
          </TabsTrigger>
          <TabsTrigger value="connected">
            <PlugZap /> Connected
          </TabsTrigger>
          <TabsTrigger value="api">
            <KeyRound /> API provider
          </TabsTrigger>
          <TabsTrigger value="secrets">
            <LockKeyhole /> Secrets
          </TabsTrigger>
        </TabsList>

        <TabsContent value="subscriptions" className="space-y-4 pt-4">
          <SectionHeader
            title="Use an existing AI plan"
            description="Bridge uses authenticated vendor CLI sessions on this machine. Subscription credentials stay in each vendor's secure store."
          />
          <div className="grid gap-3 lg:grid-cols-3">
            {CLI_PROVIDER_IDS.map((id) => {
              const entry = connected.find((item) => item.provider === id);
              const status = cliStatus?.[id];
              const pending = authPending === id;
              return (
                <Card key={id} className="rounded-lg">
                  <CardHeader>
                    <div className="mb-2">
                      <ProviderLogo provider={id} className="size-10" />
                    </div>
                    <CardTitle>{providerName(id)}</CardTitle>
                    <CardDescription>{CLI_PLAN_INFO[id].description}</CardDescription>
                    <CardAction>
                      {entry ? (
                        <Badge className="bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                          <Check /> Connected
                        </Badge>
                      ) : (
                        <Badge variant="outline">Not connected</Badge>
                      )}
                    </CardAction>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {(status?.plan || status?.account) && (
                      <div className="rounded-lg border bg-muted/30 p-3 text-sm">
                        {status.plan && <p className="font-medium">{status.plan}</p>}
                        {status.account && (
                          <p className="text-xs text-muted-foreground">{status.account}</p>
                        )}
                      </div>
                    )}
                    <div className="flex flex-wrap items-center gap-2">
                      {entry ? (
                        <Button variant="outline" onClick={() => void disconnect(id)}>
                          <Trash2 /> Disconnect
                        </Button>
                      ) : (
                        <Button
                          onClick={() => void startOAuth(id)}
                          disabled={pending || status?.installed === false}
                        >
                          {pending ? <LoaderCircle className="animate-spin" /> : <ExternalLink />}
                          {pending ? "Waiting for sign-in" : CLI_PLAN_INFO[id].action}
                        </Button>
                      )}
                      {status?.installed === false && (
                        <Badge variant="destructive">CLI not installed</Badge>
                      )}
                    </div>
                    {pending && authCommand && (
                      <Alert>
                        <LoaderCircle className="animate-spin" />
                        <AlertTitle>Finish sign-in in your terminal</AlertTitle>
                        <AlertDescription>
                          <code className="break-all font-mono text-xs">{authCommand}</code>
                        </AlertDescription>
                      </Alert>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </TabsContent>

        <TabsContent value="connected" className="space-y-4 pt-4">
          <SectionHeader
            title="Connected providers"
            description="Every model exposed by these providers appears in the chat model picker."
          />
          {connected.length === 0 ? (
            <EmptyState title="No providers connected">
              Connect a plan or API provider so agents have a model to use.
            </EmptyState>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {connected.map((entry) => (
                <Card key={entry.id} className="rounded-lg">
                  <CardHeader>
                    <ProviderLogo provider={entry.provider} className="mb-2 size-9" />
                    <CardTitle>{providerName(entry.provider)}</CardTitle>
                    <CardDescription className="break-all font-mono text-xs">
                      {entry.authType === "oauth-cli"
                        ? "Vendor OAuth session"
                        : (entry.keyHint ?? entry.baseUrl)}
                    </CardDescription>
                    <CardAction>
                      <Badge variant="outline">{entry.authType}</Badge>
                    </CardAction>
                  </CardHeader>
                  <CardContent>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void disconnect(entry.provider)}
                    >
                      <Trash2 /> Disconnect
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="api" className="space-y-4 pt-4">
          <SectionHeader
            title="Connect an API provider"
            description="Credentials are encrypted before storage and are never returned to the browser. Local and OpenAI-compatible endpoints can use a custom base URL."
          />
          <Card className="rounded-lg">
            <CardHeader>
              <CardTitle>Provider credentials</CardTitle>
              <CardDescription>
                One provider connection is shared by every agent in this workspace.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-[minmax(13rem,0.55fr)_minmax(17rem,1fr)_minmax(17rem,1fr)_auto] xl:items-end">
              <Field label="Provider">
                {(id) => (
                  <Select
                    value={provider}
                    onValueChange={(value) => {
                      const next = providerCatalogEntry(value);
                      setProvider(value);
                      setBaseUrl(next.defaultBaseUrl ?? "");
                    }}
                  >
                    <SelectTrigger id={id} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent align="start">
                      <SelectGroup>
                        <SelectLabel>Available providers</SelectLabel>
                        {apiProviders.map((name) => (
                          <SelectItem key={name} value={name}>
                            <ProviderLogo provider={name} className="size-5" /> {providerName(name)}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                )}
              </Field>
              {!endpointOnly && (
                <Field label="API key">
                  {(id) => (
                    <Input
                      id={id}
                      type="password"
                      value={apiKey}
                      onChange={(event) => setApiKey(event.target.value)}
                      placeholder="Enter provider key"
                      autoComplete="off"
                    />
                  )}
                </Field>
              )}
              {showBaseUrl ? (
                <Field
                  label="Base URL"
                  hint={
                    selectedProvider.supportsBaseUrl
                      ? "Change this for your region or plan"
                      : undefined
                  }
                >
                  {(id) => (
                    <Input
                      id={id}
                      value={baseUrl}
                      onChange={(event) => setBaseUrl(event.target.value)}
                      placeholder={
                        selectedProvider.defaultBaseUrl ?? "https://your-endpoint.example/v1"
                      }
                    />
                  )}
                </Field>
              ) : (
                <div className="hidden xl:block" />
              )}
              <Button
                onClick={() => void connect()}
                disabled={busy || (endpointOnly ? !baseUrl : !apiKey)}
              >
                <PlugZap /> {busy ? "Connecting" : "Connect provider"}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="secrets" className="space-y-4 pt-4">
          <SectionHeader
            title="Workspace secrets"
            description="Manifests refer to secrets by name. Values are encrypted at rest and never included in exports."
          />
          <Card className="rounded-lg">
            <CardHeader>
              <CardTitle>Add a secret</CardTitle>
              <CardDescription>
                Store channel tokens and service credentials used by agent tools.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 lg:grid-cols-[minmax(14rem,0.5fr)_minmax(20rem,1fr)_auto] lg:items-end">
              <Field label="Name" hint="For example telegram_bot_token">
                {(id) => (
                  <Input
                    id={id}
                    value={secretName}
                    onChange={(event) => setSecretName(event.target.value)}
                    placeholder="service_token"
                  />
                )}
              </Field>
              <Field label="Value">
                {(id) => (
                  <Input
                    id={id}
                    type="password"
                    value={secretValue}
                    onChange={(event) => setSecretValue(event.target.value)}
                    autoComplete="off"
                  />
                )}
              </Field>
              <Button onClick={() => void saveSecret()} disabled={!secretName || !secretValue}>
                <ShieldCheck /> Save secret
              </Button>
            </CardContent>
          </Card>
          <ErrorText>{secretError}</ErrorText>
          {secrets.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {secrets.map((secret) => (
                <Card key={secret.id} size="sm" className="rounded-lg">
                  <CardHeader>
                    <CardTitle className="font-mono">{secret.name}</CardTitle>
                    <CardDescription className="font-mono">{secret.hint}</CardDescription>
                    <CardAction>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Delete ${secret.name}`}
                        onClick={async () => {
                          await api.deleteSecret(workspaceId, secret.id);
                          await load();
                        }}
                      >
                        <Trash2 />
                      </Button>
                    </CardAction>
                  </CardHeader>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** Kept as a compatibility export while `/providers` redirects into Settings. */
export function Providers() {
  return <ProviderSettings />;
}
