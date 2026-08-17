import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { personalAssistantTemplate } from "@bridge/spec";
import { beforeEach, describe, expect, it } from "vitest";
import { CHARTER_FILES, charterDir, charterFor, ensureCharter, readCharter } from "./charter.js";

let dataDir: string;
const workspaceId = "ws_1";
const agentId = "agt_1";
const manifest = personalAssistantTemplate.manifest;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "bridge-charter-"));
});

describe("the four files an agent is made of", () => {
  it("writes all four from the template the user started with", async () => {
    expect(await ensureCharter(dataDir, workspaceId, agentId, manifest)).toEqual([
      ...CHARTER_FILES,
    ]);

    const charter = await readCharter(dataDir, workspaceId, agentId);
    expect(charter.map((entry) => entry.file)).toEqual([...CHARTER_FILES]);
    // Generated from the manifest, not from a fixed string.
    expect(charter.find((entry) => entry.file === "IDENTITY.md")?.content).toContain(
      manifest.meta.name,
    );
    expect(charter.find((entry) => entry.file === "AGENTS.md")?.content).toContain("web-search");
  });

  it("never overwrites an edit — by a person or by the agent", async () => {
    await ensureCharter(dataDir, workspaceId, agentId, manifest);
    const soul = join(charterDir(dataDir, workspaceId, agentId), "SOUL.md");
    await writeFile(soul, "# Be terse\n", "utf8");

    expect(await ensureCharter(dataDir, workspaceId, agentId, manifest)).toEqual([]);
    expect(await readFile(soul, "utf8")).toBe("# Be terse\n");
  });

  it("puts them where the agent can reach them with its own file tool", async () => {
    await ensureCharter(dataDir, workspaceId, agentId, manifest);
    // The sandbox root for this agent, so `read SOUL.md` just works.
    expect(charterDir(dataDir, workspaceId, agentId)).toBe(join(dataDir, workspaceId, agentId));
  });

  it("describes the team when there is one, and says so when there is not", () => {
    const withTeam = charterFor(manifest)["AGENTS.md"];
    expect(withTeam).toContain("researcher");

    const alone = structuredClone(manifest);
    alone.agents = alone.agents.filter((agent) => agent.name === alone.entryAgent);
    expect(charterFor(alone)["AGENTS.md"]).toContain("I work alone");
  });

  it("skips a file the user deleted rather than resurrecting it mid-run", async () => {
    await ensureCharter(dataDir, workspaceId, agentId, manifest);
    await writeFile(join(charterDir(dataDir, workspaceId, agentId), "USER.md"), "", "utf8");

    const charter = await readCharter(dataDir, workspaceId, agentId);
    expect(charter.map((entry) => entry.file)).not.toContain("USER.md");
  });
});
