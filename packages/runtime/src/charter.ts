import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Manifest } from "@bridge/spec";

/**
 * The four files an agent is made of.
 *
 * Everything an agent is used to live in one blob of instructions, which meant
 * that changing how it writes and changing what it knows about you were the
 * same edit. These separate the four things that actually vary, in the format
 * an agent can read and revise on its own:
 *
 *   IDENTITY.md  who it is — name, role, the shape of its job
 *   SOUL.md      how it behaves — voice, judgement, what it refuses
 *   USER.md      who you are — filled in over time, not at setup
 *   AGENTS.md    how it works — its tools, its team, its operating rules
 *
 * They live in the agent's own directory, so the filesystem tool can read and
 * edit them like anything else: an agent asked to "stop being so formal" can
 * change SOUL.md itself, and the change survives because it is a file rather
 * than a turn in a conversation nobody kept.
 */
export const CHARTER_FILES = ["IDENTITY.md", "SOUL.md", "USER.md", "AGENTS.md"] as const;
export type CharterFile = (typeof CHARTER_FILES)[number];

const stamp = "<!-- Written by Bridge at setup. Yours to edit; the agent may edit it too. -->";

/** Generate the four files from the template the user started with. */
export function charterFor(manifest: Manifest): Record<CharterFile, string> {
  const entry = manifest.agents.find((agent) => agent.name === manifest.entryAgent);
  const name = manifest.meta.name;
  const purpose = manifest.meta.description?.trim() || entry?.description?.trim() || "";
  const instructions = entry?.instructions?.trim() ?? "";
  const team = manifest.agents.filter((agent) => agent.name !== manifest.entryAgent);
  const tools = manifest.tools.map((tool) => tool.name);

  return {
    "IDENTITY.md": [
      `# ${name}`,
      stamp,
      "",
      "## What I am",
      purpose || `${name}, an agent in Bridge.`,
      "",
      "## My job",
      instructions || "_Not yet described._",
      "",
      "## What I am not",
      "- Not a search engine: I say when I do not know.",
      "- Not a replacement for your judgement on anything that matters.",
      "",
    ].join("\n"),

    "SOUL.md": [
      `# How ${name} behaves`,
      stamp,
      "",
      "## Voice",
      "- Plain language. Short sentences. No filler and no flattery.",
      "- Say the useful thing first; explain underneath if it is needed.",
      "",
      "## Judgement",
      "- When unsure, say so rather than guessing convincingly.",
      "- Do the work asked for, not the work nearby.",
      "- Report what actually happened, including the parts that failed.",
      "",
      "## Before acting",
      "- Anything that changes files, sends messages, or spends money is worth",
      "  confirming unless it has already been agreed.",
      "",
      "_Edit this file to change how I come across. It is read on every run._",
      "",
    ].join("\n"),

    "USER.md": [
      "# About the person I work for",
      stamp,
      "",
      "_This one fills itself in. What I learn about you from our conversations",
      "is consolidated here and into the knowledge graph, so I do not have to be",
      "told the same thing twice._",
      "",
      "## Known so far",
      "- Nothing yet.",
      "",
    ].join("\n"),

    "AGENTS.md": [
      `# How ${name} works`,
      stamp,
      "",
      "## Tools I have",
      tools.length ? tools.map((tool) => `- \`${tool}\``).join("\n") : "- None yet.",
      "",
      "## My team",
      team.length
        ? team.map((agent) => `- **${agent.name}** — ${agent.description ?? "subagent"}`).join("\n")
        : "- I work alone.",
      "",
      "## Operating rules",
      "- Prefer editing an exact fragment of a file over rewriting the whole thing.",
      "- Say which files I changed.",
      "- Long jobs: say what I am doing before I do it, not after.",
      "",
    ].join("\n"),
  };
}

/** Where an agent's charter lives: its own directory, alongside its work. */
export const charterDir = (dataDir: string, workspaceId: string, agentId: string) =>
  join(dataDir, workspaceId, agentId);

/**
 * Write any of the four that do not exist yet.
 *
 * Never overwrites: these are edited by hand and by the agent, and a redeploy
 * quietly reverting someone's SOUL.md would be its own bug report.
 */
export async function ensureCharter(
  dataDir: string,
  workspaceId: string,
  agentId: string,
  manifest: Manifest,
): Promise<CharterFile[]> {
  const directory = charterDir(dataDir, workspaceId, agentId);
  await mkdir(directory, { recursive: true });
  const content = charterFor(manifest);
  const written: CharterFile[] = [];

  for (const file of CHARTER_FILES) {
    const path = join(directory, file);
    const exists = await readFile(path, "utf8").then(
      () => true,
      () => false,
    );
    if (exists) continue;
    await writeFile(path, content[file], "utf8");
    written.push(file);
  }
  return written;
}

/** Read the charter back for a run, skipping any the user has deleted. */
export async function readCharter(
  dataDir: string,
  workspaceId: string,
  agentId: string,
): Promise<{ file: CharterFile; content: string }[]> {
  const directory = charterDir(dataDir, workspaceId, agentId);
  const found = await Promise.all(
    CHARTER_FILES.map(async (file) => {
      const content = await readFile(join(directory, file), "utf8").catch(() => undefined);
      return content?.trim() ? { file, content: content.trim() } : undefined;
    }),
  );
  return found.filter((entry): entry is { file: CharterFile; content: string } => Boolean(entry));
}
