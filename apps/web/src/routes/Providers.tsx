import { useCallback, useEffect, useState } from "react";
import { api, BridgeApiError, type ProviderConfig } from "../api.js";
import { useWorkspaceId } from "../session.jsx";
import { Button, Card, EmptyState, ErrorText, Field, Input, Spinner } from "../ui.jsx";

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

  const load = useCallback(async () => {
    const [{ providers }, { providers: list }] = await Promise.all([
      api.providers(workspaceId),
      api.availableProviders(workspaceId),
    ]);
    setConnected(providers);
    setAvailable(list);
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

  if (!connected) return <Spinner label="Loading providers" />;

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <div>
          <h2 className="text-sm font-semibold">Connect a provider</h2>
          <p className="text-sm text-text-muted">
            Keys are encrypted before they are stored and are never sent back to this app. Running
            Bridge locally does not mean the model has to be local.
          </p>
        </div>

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
        <h2 className="text-sm font-semibold">Connected</h2>
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
                <span className="flex flex-col">
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
    </div>
  );
}
