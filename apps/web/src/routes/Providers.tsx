import { useCallback, useEffect, useState } from "react";
import { api, BridgeApiError, type ProviderConfig, type SecretRef } from "../api.js";
import { useWorkspaceId } from "../session.jsx";
import {
  Button,
  Card,
  EmptyState,
  ErrorText,
  Field,
  Input,
  SectionHeader,
  Spinner,
} from "../ui.jsx";

/** Providers that authenticate with a URL rather than an API key. */
const LOCAL_PROVIDERS = new Set(["ollama", "openai-compatible"]);

export function Providers() {
  const workspaceId = useWorkspaceId();
  const [connected, setConnected] = useState<ProviderConfig[] | null>(null);
  const [available, setAvailable] = useState<string[]>([]);
  const [provider, setProvider] = useState("anthropic");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [secrets, setSecrets] = useState<SecretRef[]>([]);
  const [secretName, setSecretName] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const [secretError, setSecretError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [{ providers }, { providers: list }, { secrets: stored }] = await Promise.all([
      api.providers(workspaceId),
      api.availableProviders(workspaceId),
      api.secrets(workspaceId),
    ]);
    setConnected(providers);
    setAvailable(list);
    setSecrets(stored);
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const isLocal = LOCAL_PROVIDERS.has(provider);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.connectProvider(workspaceId, {
        provider,
        apiKey: isLocal ? undefined : apiKey,
        baseUrl: isLocal ? baseUrl : undefined,
      });
      setApiKey("");
      setBaseUrl("");
      await load();
    } catch (err) {
      setError(err instanceof BridgeApiError ? err.error.message : "Could not connect.");
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
    } catch (err) {
      setSecretError(err instanceof BridgeApiError ? err.error.message : "Could not save.");
    }
  };

  if (!connected) return <Spinner label="Loading providers" />;

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <SectionHeader
          title="Connect a provider"
          description="Keys are encrypted before they are stored and never sent back to this app. Running Bridge locally does not mean the model has to be local."
        />

        <Card className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Provider">
              {(id) => (
                <select
                  id={id}
                  value={provider}
                  onChange={(e) => setProvider(e.target.value)}
                  className="w-full rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-2 text-sm text-text outline-none focus:border-border-strong"
                >
                  {available.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              )}
            </Field>

            {isLocal ? (
              <Field label="Base URL" hint="For example http://localhost:11434">
                {(id) => (
                  <Input
                    id={id}
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder="http://localhost:11434"
                  />
                )}
              </Field>
            ) : (
              <Field label="API key">
                {(id) => (
                  <Input
                    id={id}
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="sk-…"
                    autoComplete="off"
                  />
                )}
              </Field>
            )}
          </div>
          <ErrorText>{error}</ErrorText>
          <div>
            <Button onClick={connect} disabled={busy || (isLocal ? !baseUrl : !apiKey)}>
              {busy ? "Connecting…" : "Connect"}
            </Button>
          </div>
        </Card>
      </section>

      <section className="flex flex-col gap-3">
        <SectionHeader title="Connected" />
        {connected.length === 0 ? (
          <EmptyState title="No providers connected">
            Connect at least one so your agents have a model to use.
          </EmptyState>
        ) : (
          <ul className="flex flex-col gap-2">
            {connected.map((entry) => (
              <li
                key={entry.id}
                className="flex items-center justify-between rounded-[var(--radius-md)] border border-border bg-bg-raised px-4 py-3"
              >
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">{entry.provider}</span>
                  <span className="font-mono text-xs text-text-faint">
                    {entry.keyHint ?? entry.baseUrl}
                  </span>
                </span>
                <Button variant="ghost" onClick={() => disconnect(entry.provider)}>
                  Disconnect
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <SectionHeader
          title="Secrets"
          description="Values a manifest refers to by name — a Telegram or Discord bot token, for example. Encrypted at rest and never returned, so an exported agent carries the name, not the secret."
        />

        <Card className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" hint="Referenced as tokenSecret in a channel binding">
              {(id) => (
                <Input
                  id={id}
                  value={secretName}
                  onChange={(e) => setSecretName(e.target.value)}
                  placeholder="telegram_bot_token"
                />
              )}
            </Field>
            <Field label="Value">
              {(id) => (
                <Input
                  id={id}
                  type="password"
                  value={secretValue}
                  onChange={(e) => setSecretValue(e.target.value)}
                  autoComplete="off"
                />
              )}
            </Field>
          </div>
          <ErrorText>{secretError}</ErrorText>
          <div>
            <Button onClick={saveSecret} disabled={!secretName || !secretValue}>
              Save secret
            </Button>
          </div>
        </Card>

        {secrets.length > 0 && (
          <ul className="flex flex-col gap-2">
            {secrets.map((secret) => (
              <li
                key={secret.id}
                className="flex items-center justify-between rounded-[var(--radius-md)] border border-border bg-bg-raised px-4 py-3"
              >
                <span className="flex flex-col">
                  <span className="font-mono text-sm">{secret.name}</span>
                  <span className="font-mono text-xs text-text-faint">{secret.hint}</span>
                </span>
                <Button
                  variant="ghost"
                  onClick={async () => {
                    await api.deleteSecret(workspaceId, secret.id);
                    await load();
                  }}
                >
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
