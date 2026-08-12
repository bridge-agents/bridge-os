import type { CompletionResult, Provider } from "@bridge/sdk";
import { personalAssistantTemplate, safeParseManifest } from "@bridge/spec";
import { describe, expect, it } from "vitest";
import { proposeManifest } from "./architect.js";

/** Provider that replays canned designs, so the loop is tested without a network. */
function designer(responses: string[]): Provider & { calls: number } {
  let index = 0;
  const provider = {
    id: "test",
    calls: 0,
    async complete(): Promise<CompletionResult> {
      provider.calls += 1;
      return {
        message: {
          role: "assistant",
          content: responses[Math.min(index++, responses.length - 1)] ?? "",
        },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end",
      };
    },
  };
  return provider;
}

const validManifest = JSON.stringify(personalAssistantTemplate.manifest);

describe("proposeManifest", () => {
  it("returns a validated manifest on the first try", async () => {
    const provider = designer([validManifest]);
    const { manifest, attempts } = await proposeManifest({
      provider,
      model: "test-model",
      context: "",
      instruction: "design something",
    });

    expect(attempts).toBe(1);
    expect(safeParseManifest(manifest).success).toBe(true);
  });

  it("strips markdown fences the model adds anyway", async () => {
    const provider = designer([`Here you go:\n\`\`\`json\n${validManifest}\n\`\`\``]);
    const { manifest } = await proposeManifest({
      provider,
      model: "test-model",
      context: "",
      instruction: "design",
    });
    expect(manifest.meta.slug).toBe("personal-assistant");
  });

  it("feeds validation errors back and accepts the corrected manifest", async () => {
    // First reply references a tool that was never declared.
    const broken = structuredClone(personalAssistantTemplate.manifest);
    broken.agents[0]?.tools.push("gmail");

    const provider = designer([JSON.stringify(broken), validManifest]);
    const { manifest, attempts } = await proposeManifest({
      provider,
      model: "test-model",
      context: "",
      instruction: "design",
    });

    expect(attempts).toBe(2);
    expect(provider.calls).toBe(2);
    expect(safeParseManifest(manifest).success).toBe(true);
  });

  it("gives up with actionable detail when the model never gets it right", async () => {
    const provider = designer(["not json at all"]);
    await expect(
      proposeManifest({ provider, model: "m", context: "", instruction: "design" }),
    ).rejects.toMatchObject({ code: "provider_error" });
    // Bounded: it does not retry forever.
    expect(provider.calls).toBe(3);
  });

  it("surfaces a provider refusal rather than retrying it", async () => {
    const refusing: Provider = {
      id: "test",
      async complete() {
        return {
          message: { role: "assistant", content: "" },
          usage: { inputTokens: 0, outputTokens: 0 },
          stopReason: "refusal",
        };
      },
    };
    await expect(
      proposeManifest({ provider: refusing, model: "m", context: "", instruction: "x" }),
    ).rejects.toThrow(/declined/);
  });
});
