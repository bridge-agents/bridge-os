import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The CLI talks to exactly the same public API as the web app — no private
 * endpoints, no shared server code (ADR-0005). If something is possible in the
 * browser and not here, that is a missing public endpoint, not a CLI gap.
 */
export interface CliConfig {
  apiUrl: string;
  token?: string;
  workspaceId?: string;
}

const CONFIG_PATH = join(homedir(), ".bridge", "config.json");
const DEFAULT_API = "http://localhost:4000";

export async function loadConfig(): Promise<CliConfig> {
  const fromEnv = {
    ...(process.env.BRIDGE_API_URL ? { apiUrl: process.env.BRIDGE_API_URL } : {}),
    ...(process.env.BRIDGE_TOKEN ? { token: process.env.BRIDGE_TOKEN } : {}),
    ...(process.env.BRIDGE_WORKSPACE ? { workspaceId: process.env.BRIDGE_WORKSPACE } : {}),
  };

  const saved = await readFile(CONFIG_PATH, "utf8")
    .then((text) => JSON.parse(text) as Partial<CliConfig>)
    .catch(() => ({}));

  // Environment wins over the saved file, which wins over the default.
  return { apiUrl: DEFAULT_API, ...saved, ...fromEnv };
}

export async function saveConfig(config: CliConfig): Promise<void> {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  // 0600: the file holds a session token.
  await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export class CliError extends Error {}

export interface ApiClientOptions {
  apiUrl: string;
  token?: string;
  fetchImpl?: typeof fetch;
}

/** Thin typed wrapper over the Bridge HTTP API. */
export class ApiClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ApiClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.options.token ? { authorization: `Bearer ${this.options.token}` } : {}),
    };
  }

  /**
   * `fetch` throws a bare `TypeError: fetch failed` for a refused or
   * unresolvable connection — every command routes through here, so this is
   * the one place to turn that into something a user can act on instead of
   * a stack-free stringified TypeError.
   */
  private async doFetch(path: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.options.apiUrl}${path}`, init);
    } catch {
      throw new CliError(
        `Can't reach Bridge at ${this.options.apiUrl}. Is the API running?\n` +
          "  Start it with `pnpm dev` from the project root, then try again.",
      );
    }
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.doFetch(path, {
      ...init,
      headers: { ...this.headers(), ...(init.headers ?? {}) },
    });

    if (res.status === 204) return undefined as T;
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; details?: { path: string; message: string }[] };
    };

    if (!res.ok) {
      const detail = body.error?.details?.map((d) => `\n  ${d.path}: ${d.message}`).join("") ?? "";
      throw new CliError(`${body.error?.message ?? res.statusText}${detail}`);
    }
    return body as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>(path);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, {
      method: "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  /** Yields `{event, data}` records from a run's SSE stream. */
  async *stream(path: string): AsyncGenerator<{ event: string; data: Record<string, unknown> }> {
    const res = await this.doFetch(path, { headers: this.headers() });
    if (!res.ok || !res.body) throw new CliError(`stream failed (${res.status})`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are blank-line separated; hold the trailing partial frame.
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const event = frame.match(/^event:\s*(.+)$/m)?.[1];
        const data = frame.match(/^data:\s*(.+)$/m)?.[1];
        if (!event || !data) continue;
        try {
          yield { event, data: JSON.parse(data) as Record<string, unknown> };
        } catch {
          // Ignore heartbeats and anything that is not a JSON payload.
        }
      }
    }
  }
}
