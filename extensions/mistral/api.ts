import { asOptionalObjectRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { resolveMistralReasoningEffortMap } from "./provider-policy-api.js";

// Configured routes (for example a proxy base URL) may list a bundled model without its map;
// the bundled row still owns that model's reasoning-effort facts.
const BUNDLED_THINKING_MAPS: ReadonlyMap<string, Partial<Record<string, string | null>>> = new Map(
  manifest.modelCatalog.providers.mistral.models.flatMap((row) =>
    "thinkingLevelMap" in row && row.thinkingLevelMap ? [[row.id, row.thinkingLevelMap]] : [],
  ),
);

export { buildMistralProvider } from "./provider-catalog.js";
export {
  buildMistralModelDefinition,
  MISTRAL_BASE_URL,
  MISTRAL_DEFAULT_MODEL_ID,
  MISTRAL_DEFAULT_MODEL_REF,
} from "./model-definitions.js";
export { applyMistralConfig, applyMistralProviderConfig } from "./onboard.js";
export {
  MISTRAL_SMALL_LATEST_ID,
  MISTRAL_SMALL_4_ID,
  MISTRAL_MEDIUM_3_5_ID,
} from "./provider-policy-api.js";

export const MISTRAL_MODEL_TRANSPORT_PATCH = {
  supportsStore: false,
  supportsPromptCacheKey: true,
  supportsLongCacheRetention: false,
  maxTokensField: "max_tokens",
} as const;

export function resolveMistralCompatPatch(model: {
  id?: string;
  thinkingLevelMap?: Partial<Record<string, string | null>>;
}) {
  const reasoningEffortMap = resolveMistralReasoningEffortMap(
    model.thinkingLevelMap ?? (model.id ? BUNDLED_THINKING_MAPS.get(model.id) : undefined),
  );
  return {
    ...MISTRAL_MODEL_TRANSPORT_PATCH,
    supportsReasoningEffort: reasoningEffortMap !== undefined,
    reasoningEffortMap,
  };
}

export function applyMistralModelCompat<
  T extends {
    compat?: unknown;
    id?: string;
    thinkingLevelMap?: Partial<Record<string, string | null>>;
  },
>(model: T): T {
  const compat = asOptionalObjectRecord(model.compat);
  const patch = resolveMistralCompatPatch(model);
  if (Object.entries(patch).every(([key, value]) => compat?.[key] === value)) {
    return model;
  }
  return {
    ...model,
    compat: { ...compat, ...patch },
  };
}
