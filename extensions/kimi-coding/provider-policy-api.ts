// Kimi Code policy module exposes model-specific thinking controls before runtime registration.
import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
} from "openclaw/plugin-sdk/plugin-entry";
import manifest from "./openclaw.plugin.json" with { type: "json" };

type KimiThinkingFacts = Pick<ProviderDefaultThinkingPolicyContext, "thinkingLevelMap"> & {
  compat?: object | null;
};

const MANIFEST_ROWS: ReadonlyMap<string, KimiThinkingFacts> = new Map(
  manifest.modelCatalog.providers.kimi.models.map((row) => [row.id, row]),
);
const MODEL_ALIASES: ReadonlyMap<string, string> = new Map(
  Object.entries(manifest.modelIdNormalization.providers.kimi.aliases),
);
// Self-hosted K3 serves this wire ID, which has no Kimi Code catalog row; thinking stays off by
// default there (README "Catalog notes").
const KIMI_K3_SELF_HOSTED_MODEL_ID = "kimi-k3";
// Kimi Code's K2.8 backend leaks reasoning when thinking is disabled. Released readers still
// offer `off` for these rows, so `off: null` in hosted data would change them.
const KIMI_CODE_ENABLED_ONLY_MODEL_IDS = new Set(["kimi-for-coding", "kimi-for-coding-highspeed"]);

export const KIMI_K3_THINKING_EFFORTS = {
  minimal: "low",
  low: "low",
  medium: "high",
  high: "high",
  xhigh: "max",
  max: "max",
} as const;

const KIMI_K3_THINKING_LEVELS = [
  { id: "off" },
  { id: "minimal" },
  { id: "low" },
  { id: "medium" },
  { id: "high" },
  { id: "adaptive" },
  { id: "xhigh" },
  { id: "max" },
] as const satisfies ProviderThinkingProfile["levels"];

function readEfforts(compat: object | null | undefined): readonly string[] | undefined {
  const efforts =
    compat && "supportedReasoningEfforts" in compat ? compat.supportedReasoningEfforts : undefined;
  return Array.isArray(efforts) && efforts.every((effort) => typeof effort === "string")
    ? efforts
    : undefined;
}

function normalizeModelId(modelId: string): string {
  const normalized = modelId.trim().toLowerCase();
  return MODEL_ALIASES.get(normalized) ?? normalized;
}

/** K3-family rows list their efforts; the request then uses adaptive thinking with that effort. */
export function isKimiK3Model(modelId: string, facts?: KimiThinkingFacts | null): boolean {
  const id = normalizeModelId(modelId);
  const efforts = readEfforts(facts?.compat) ?? readEfforts(MANIFEST_ROWS.get(id)?.compat);
  return id === KIMI_K3_SELF_HOSTED_MODEL_ID || (efforts?.length ?? 0) > 0;
}

/** Kimi Code models whose backend cannot honor disabled thinking: their row maps `off` to null. */
export function isKimiCodeEnabledOnlyModel(
  modelId: string,
  facts?: KimiThinkingFacts | null,
): boolean {
  const id = normalizeModelId(modelId);
  const map =
    facts?.thinkingLevelMap && "off" in facts.thinkingLevelMap
      ? facts.thinkingLevelMap
      : MANIFEST_ROWS.get(id)?.thinkingLevelMap;
  return map?.off === null || KIMI_CODE_ENABLED_ONLY_MODEL_IDS.has(id);
}

export function resolveThinkingProfile(
  context: ProviderDefaultThinkingPolicyContext,
): ProviderThinkingProfile {
  const enabledOnly = isKimiCodeEnabledOnlyModel(context.modelId, context);
  if (isKimiK3Model(context.modelId, context)) {
    return {
      levels: enabledOnly
        ? KIMI_K3_THINKING_LEVELS.filter(({ id }) => id !== "off")
        : KIMI_K3_THINKING_LEVELS,
      defaultLevel:
        context.modelId.trim().toLowerCase() === KIMI_K3_SELF_HOSTED_MODEL_ID ? "off" : "high",
      preserveWhenCatalogReasoningFalse: true,
    };
  }
  if (enabledOnly) {
    return { levels: [{ id: "low", label: "on" }], defaultLevel: "low" };
  }
  return {
    levels: [
      { id: "off", label: "off" },
      { id: "low", label: "on" },
    ],
    defaultLevel: "off",
  };
}
