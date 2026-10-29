import type { ProviderDefaultThinkingPolicyContext } from "openclaw/plugin-sdk/plugin-entry";
import manifest from "./openclaw.plugin.json" with { type: "json" };

export const MISTRAL_SMALL_LATEST_ID = "mistral-small-latest";
export const MISTRAL_SMALL_4_ID = "mistral-small-2603";
export const MISTRAL_MEDIUM_3_5_ID = "mistral-medium-3-5";

const LEVEL_ORDER = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "adaptive",
  "max",
] as const;

// Configured routes (for example a proxy base URL) may list a bundled model without its map;
// the bundled row still owns that model's reasoning-effort facts.
const BUNDLED_THINKING_MAPS: ReadonlyMap<string, Partial<Record<string, string | null>>> = new Map(
  manifest.modelCatalog.providers.mistral.models.flatMap((row) =>
    "thinkingLevelMap" in row && row.thinkingLevelMap ? [[row.id, row.thinkingLevelMap]] : [],
  ),
);

/**
 * A reasoning row maps each level to its `reasoning_effort`. The catalog has no field for
 * `adaptive` yet, so Mistral offers it on every such row and sends it as `high`.
 */
export function resolveMistralReasoningEffortMap(
  thinkingLevelMap: Partial<Record<string, string | null>> | undefined,
  modelId?: string,
): Record<string, string> | undefined {
  const rowMap = thinkingLevelMap ?? (modelId ? BUNDLED_THINKING_MAPS.get(modelId) : undefined);
  const map: Partial<Record<string, string | null>> = { ...rowMap, adaptive: "high" };
  const entries = LEVEL_ORDER.flatMap((level) =>
    typeof map[level] === "string" ? [[level, map[level]] as const] : [],
  );
  return entries.length > 1 ? Object.fromEntries(entries) : undefined;
}

export function resolveThinkingProfile({
  modelId,
  thinkingLevelMap,
}: ProviderDefaultThinkingPolicyContext) {
  const map = resolveMistralReasoningEffortMap(thinkingLevelMap, modelId);
  return map
    ? {
        levels: LEVEL_ORDER.filter((id) => id in map).map((id) => ({ id })),
        defaultLevel: "off" as const,
      }
    : undefined;
}
