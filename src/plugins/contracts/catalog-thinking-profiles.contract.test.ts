import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { resolveThinkingProfile } from "../../auto-reply/thinking.js";
import type { ThinkingCatalogEntry } from "../../auto-reply/thinking.shared.js";
import { listGitTrackedFiles } from "../../test-utils/repo-files.js";

// Rows that set compat.defaultThinkingLevel own their thinking profile; no provider hook runs.
// Each expectation is the profile the deleted provider hook returned for that row.
const EXPECTED: Record<string, { levels: string[]; defaultLevel: string }> = {
  "deepseek/deepseek-flash": deepSeekV4(),
  "deepseek/deepseek-v4-flash": deepSeekV4(),
  "deepseek/deepseek-v4-flash-vision-exp": deepSeekV4(),
  "deepseek/deepseek-v4-pro": deepSeekV4(),
  "mistral/mistral-medium-3-5": mistralReasoning(),
  "mistral/mistral-small-2603": mistralReasoning(),
  "mistral/mistral-small-latest": mistralReasoning(),
};

function mistralReasoning() {
  return {
    levels: ["off", "minimal", "low", "medium", "adaptive", "high", "xhigh", "max"],
    defaultLevel: "off",
  };
}

function deepSeekV4() {
  return {
    levels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    defaultLevel: "high",
  };
}

const repoRoot = path.resolve(import.meta.dirname, "../../..");

function readRowsOwningThinking(): ThinkingCatalogEntry[] {
  const files = listGitTrackedFiles({ repoRoot, pathspecs: "extensions" }) ?? [];
  return files
    .filter((file) => /^extensions\/[^/]+\/openclaw\.plugin\.json$/.test(file))
    .flatMap((file) => {
      const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, file), "utf8")) as {
        modelCatalog?: {
          providers?: Record<string, { api?: string; models?: ThinkingCatalogEntry[] }>;
        };
      };
      return Object.entries(manifest.modelCatalog?.providers ?? {}).flatMap(([provider, catalog]) =>
        (catalog.models ?? [])
          .filter((row) => row.compat?.defaultThinkingLevel)
          .map((row) => ({ ...row, provider, api: row.api ?? catalog.api })),
      );
    });
}

it("resolves every row that owns its thinking profile to its recorded profile", () => {
  const actual = Object.fromEntries(
    readRowsOwningThinking().map((row) => {
      const profile = resolveThinkingProfile({
        provider: row.provider,
        model: row.id,
        catalog: [row],
        agentRuntime: "openclaw",
        // Rows that own their profile never reach a provider hook.
        providerPolicySource: { resolveThinkingProfile: () => ({ levels: [{ id: "off" }] }) },
      } as never);
      return [
        `${row.provider}/${row.id}`,
        {
          levels: profile.levels.map(({ id }) => id).filter((id) => id !== "ultra"),
          defaultLevel: profile.defaultLevel,
        },
      ];
    }),
  );
  expect(actual).toEqual(EXPECTED);
});
