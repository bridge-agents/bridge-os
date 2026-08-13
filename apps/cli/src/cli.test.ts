import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "@bridge/api/app";
import { createLogger, generateSecretKey, parseSecretKey } from "@bridge/core";
import { createDb, type DbHandle } from "@bridge/db";
import { RunExecutor } from "@bridge/runtime";
import type { CompletionResult, DeltaHandler, Provider } from "@bridge/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient, type CliConfig } from "./client.js";
import {
  chat,
  decideApproval,
  listAgents,
  listApprovals,
  listRuns,
  logs,
  runAgent,
  status,
} from "./commands.js";

/**
 * The CLI is exercised against a real Bridge API (embedded Postgres), through
 * the same HTTP surface the browser uses — which is the point of the test:
 * if the CLI needs something private, this cannot be written.
 */
const silentLogger = createLogger("test");
silentLogger.level = "silent";

let handle: DbHandle;
let app: ReturnType<typeof buildApp>;
let config: CliConfig;
let out: string[];
let dataDir: string;
let agentSlug: string;

function ctx() {
  return {
    config,
    client: new ApiClient({
      apiUrl: "http://api.test",
      token: config.token,
      // Route the CLI's fetch straight into the Hono app: no socket needed,
      // but every call still goes through real routing and auth.
      fetchImpl: (async (url: string | URL, init?: RequestInit) =>
        app.request(
          new URL(String(url)).pathname + new URL(String(url)).search,
          init,
        )) as unknown as typeof fetch,
    }),
    out: (line: string) => out.push(line),
  };
}

const provider: Provider = {
  id: "openai-compatible",
  async complete(): Promise<CompletionResult> {
    return {
      message: { role: "assistant", content: "Hello from the agent." },
      usage: { inputTokens: 20, outputTokens: 8 },
      stopReason: "end",
      model: "local",
    };
  },
  async streamComplete(_request, onDelta: DeltaHandler): Promise<CompletionResult> {
    for (const word of ["Hello ", "from ", "the ", "agent."]) onDelta(word);
    return {
      message: { role: "assistant", content: "Hello from the agent." },
      usage: { inputTokens: 20, outputTokens: 8 },
      stopReason: "end",
      model: "local",
    };
  },
};

function executor() {
  return new RunExecutor({
    db: handle.db,
    logger: silentLogger,
    getProvider: async () => provider,
    dataDir,
  });
}

beforeEach(async () => {
  handle = await createDb("pglite:memory");
  await handle.migrate();
  dataDir = await mkdtemp(join(tmpdir(), "bridge-cli-"));
  out = [];

  app = buildApp({
    db: handle.db,
    logger: silentLogger,
    secretKey: parseSecretKey(generateSecretKey()),
    secureCookies: false,
  });

  // Sign up through the API, exactly as `bridge login` would.
  const signup = await app.request("/v1/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "cli@example.com", password: "a-sufficiently-long-password" }),
  });
  const account = (await signup.json()) as { token: string; workspace: { id: string } };
  config = {
    apiUrl: "http://api.test",
    token: account.token,
    workspaceId: account.workspace.id,
  };

  const authed = ctx().client;
  await authed.request(`/v1/workspaces/${config.workspaceId}/providers`, {
    method: "PUT",
    body: JSON.stringify({ provider: "openai-compatible", baseUrl: "http://localhost:9/v1" }),
  });

  const created = await authed.post<{
    agent: { manifest: { meta: { slug: string } }; id: string };
  }>(`/v1/workspaces/${config.workspaceId}/agents`, {
    manifest: {
      specVersion: 1,
      meta: { name: "Helper", slug: "helper" },
      models: { default: { provider: "openai-compatible", model: "local" } },
      agents: [{ name: "main", instructions: "Help." }],
      entryAgent: "main",
    },
  });
  agentSlug = created.agent.manifest.meta.slug;
  await authed.post(`/v1/workspaces/${config.workspaceId}/agents/${created.agent.id}/deploy`);
}, 60_000);

afterEach(async () => {
  await handle?.close();
});

describe("bridge status", () => {
  it("reports health, agents and pending approvals", async () => {
    await status(ctx());
    // Strip ANSI styling before asserting on the text.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes
    const text = out.join("\n").replace(/\u001b\[\d+m/g, "");
    expect(text).toMatch(/^Bridge 0\.\d+\.\d+ — ok/m);
    expect(text).toContain("db:up");
    expect(text).toContain("1 agent(s), 1 deployed");
  });
});

describe("bridge agent", () => {
  it("lists agents by slug", async () => {
    await listAgents(ctx());
    expect(out.join("\n")).toContain("helper");
  });

  it("runs an agent and follows the stream to completion", async () => {
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    // Streamed text goes to stdout directly; capture it for the assertion.
    process.stdout.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      await Promise.all([
        runAgent(ctx(), agentSlug, "say hello"),
        (async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          await executor().runOnce();
        })(),
      ]);
    } finally {
      process.stdout.write = original;
    }

    expect(written.join("")).toContain("Hello from the agent.");
  });

  it("refuses an unknown agent by name", async () => {
    await expect(runAgent(ctx(), "ghost", "hi")).rejects.toThrow(/no agent named/);
  });
});

describe("bridge chat", () => {
  it("picks the first deployed agent when none is named", async () => {
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    // One message, then an empty line to leave the REPL.
    const questions = ["hi there", ""];
    const prompt = async () => questions.shift() ?? "";

    try {
      await Promise.all([
        chat({ ...ctx(), prompt }),
        (async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          await executor().runOnce();
        })(),
      ]);
    } finally {
      process.stdout.write = original;
    }

    expect(written.join("")).toContain("Hello from the agent.");
  });

  it("refuses without an interactive terminal", async () => {
    await expect(chat(ctx())).rejects.toThrow(/interactive terminal/);
  });
});

describe("bridge runs and logs", () => {
  it("lists runs with usage, then prints the trace", async () => {
    const client = ctx().client;
    const { agents } = await client.get<{ agents: { id: string }[] }>(
      `/v1/workspaces/${config.workspaceId}/agents`,
    );
    const { run } = await client.post<{ run: { id: string } }>(
      `/v1/workspaces/${config.workspaceId}/agents/${agents[0]?.id}/runs`,
      { input: "hello" },
    );
    await executor().runOnce();

    await listRuns(ctx(), agentSlug);
    expect(out.join("\n")).toContain("succeeded");

    out = [];
    await logs(ctx(), run.id);
    const text = out.join("\n");
    expect(text).toContain("succeeded");
    expect(text).toContain("model_call");
    expect(text).toContain("Hello from the agent.");
  });
});

describe("bridge approvals", () => {
  it("lists a pending approval and approves it", async () => {
    const client = ctx().client;
    const { agent } = await client.post<{ agent: { id: string } }>(
      `/v1/workspaces/${config.workspaceId}/agents`,
      {
        manifest: {
          specVersion: 1,
          meta: { name: "Writer", slug: "writer" },
          models: { default: { provider: "openai-compatible", model: "local" } },
          agents: [{ name: "main", instructions: "Write.", tools: ["filesystem"] }],
          entryAgent: "main",
          tools: [{ name: "filesystem", kind: "native" }],
          permissions: { default: "ask", rules: [] },
        },
      },
    );
    await client.post(`/v1/workspaces/${config.workspaceId}/agents/${agent.id}/deploy`);
    await client.post(`/v1/workspaces/${config.workspaceId}/agents/${agent.id}/runs`, {
      input: "write a file",
    });

    const asking: Provider = {
      id: "openai-compatible",
      async complete(): Promise<CompletionResult> {
        return {
          message: {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "c1",
                name: "filesystem",
                arguments: { operation: "write", path: "a.txt", content: "x" },
              },
            ],
          },
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "tool_use",
          model: "local",
        };
      },
    };
    await new RunExecutor({
      db: handle.db,
      logger: silentLogger,
      getProvider: async () => asking,
      dataDir,
    }).runOnce();

    await listApprovals(ctx());
    const listed = out.join("\n");
    expect(listed).toContain("filesystem");
    expect(listed).toContain("a.txt");

    const approvalId = listed.match(/apr_[0-9a-f]+/)?.[0];
    if (!approvalId) throw new Error("no approval id in output");

    out = [];
    await decideApproval(ctx(), approvalId, true);
    expect(out.join("\n")).toContain("Approved");

    // Nothing left waiting once decided.
    out = [];
    await listApprovals(ctx());
    expect(out.join("\n")).toContain("Nothing waiting");
  });

  it("sends a denial reason through to the API", async () => {
    await expect(decideApproval(ctx(), "apr_missing", false, "no")).rejects.toThrow(
      /no pending approval/,
    );
  });
});
