import type { ProviderDefaultThinkingPolicyContext } from "openclaw/plugin-sdk/plugin-entry";

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

/**
 * A reasoning row maps each level to its `reasoning_effort`. The catalog has no field for
 * `adaptive` yet, so Mistral offers it on every such row and sends it as `high`.
 */
export function resolveMistralReasoningEffortMap(
  thinkingLevelMap: Partial<Record<string, string | null>> | undefined,
): Record<string, string> | undefined {
  const map: Partial<Record<string, string | null>> = { ...thinkingLevelMap, adaptive: "high" };
  const entries = LEVEL_ORDER.flatMap((level) =>
    typeof map[level] === "string" ? [[level, map[level]] as const] : [],
  );
  return entries.length > 1 ? Object.fromEntries(entries) : undefined;
}

export function resolveThinkingProfile({ thinkingLevelMap }: ProviderDefaultThinkingPolicyContext) {
  const map = resolveMistralReasoningEffortMap(thinkingLevelMap);
  return map
    ? {
        levels: LEVEL_ORDER.filter((id) => id in map).map((id) => ({ id })),
        defaultLevel: "off" as const,
      }
    : undefined;
}
