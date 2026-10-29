// Moonshot policy module exposes model-specific thinking controls before runtime registration.
import type { ProviderDefaultThinkingPolicyContext } from "openclaw/plugin-sdk/core";
import manifest from "./openclaw.plugin.json" with { type: "json" };

export const MOONSHOT_BASE_URL = "https://api.moonshot.ai/v1";
export const MOONSHOT_CN_BASE_URL = "https://api.moonshot.cn/v1";

type MoonshotThinkingFacts = Pick<ProviderDefaultThinkingPolicyContext, "thinkingLevelMap"> & {
  compat?: object | null;
};

function readEfforts(compat: object | null | undefined): readonly string[] | undefined {
  const efforts =
    compat && "supportedReasoningEfforts" in compat ? compat.supportedReasoningEfforts : undefined;
  return Array.isArray(efforts) && efforts.every((effort) => typeof effort === "string")
    ? efforts
    : undefined;
}

const MANIFEST_ROWS: ReadonlyMap<string, MoonshotThinkingFacts & { input: readonly string[] }> =
  new Map(manifest.modelCatalog.providers.moonshot.models.map((row) => [row.id, row]));

/**
 * Fills the thinking facts a route lacks from its bundled manifest row. Hosted rows win; the
 * manifest covers configured models and hosted rows published before these facts existed.
 */
export function withMoonshotThinkingFacts<T extends MoonshotThinkingFacts>(
  modelId: string,
  facts: T,
): T {
  const row = MANIFEST_ROWS.get(modelId.trim().toLowerCase());
  if (!row) {
    return facts;
  }
  const efforts = readEfforts(facts.compat) ?? readEfforts(row.compat);
  return {
    ...facts,
    // Missing keys keep the bundled mapping (for example `off: null`); supplied keys win.
    thinkingLevelMap:
      row.thinkingLevelMap || facts.thinkingLevelMap
        ? { ...row.thinkingLevelMap, ...facts.thinkingLevelMap }
        : undefined,
    ...(efforts ? { compat: { ...facts.compat, supportedReasoningEfforts: efforts } } : {}),
  };
}

/**
 * A route whose row maps `off` to null always thinks. With listed efforts it runs at the highest
 * one; without, thinking is a plain on switch.
 */
export function resolveMoonshotAlwaysThinkingEffort(
  facts: MoonshotThinkingFacts,
): { effort?: string } | undefined {
  if (facts.thinkingLevelMap?.off !== null) {
    return undefined;
  }
  return { effort: readEfforts(facts.compat)?.at(-1) };
}

const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function isNativeMoonshotBaseUrl(baseUrl: string | undefined): boolean {
  return [MOONSHOT_BASE_URL, MOONSHOT_CN_BASE_URL].some(
    (official) => baseUrl === official || baseUrl === `${official}/`,
  );
}

// Released readers drop `video` from hosted rows, so native video is read from the bundled row.
export function isMoonshotK3NativeVideoRoute(route: {
  provider?: string;
  modelId?: string;
  api?: string;
  baseUrl?: string;
}): boolean {
  return (
    route.provider === "moonshot" &&
    MANIFEST_ROWS.get(route.modelId ?? "")?.input.includes("video") === true &&
    route.api === "openai-completions" &&
    isNativeMoonshotBaseUrl(route.baseUrl)
  );
}

export function isMoonshotAlwaysThinkingModel(
  modelId: string,
  facts: MoonshotThinkingFacts = {},
): boolean {
  return (
    resolveMoonshotAlwaysThinkingEffort(withMoonshotThinkingFacts(modelId, facts)) !== undefined
  );
}

export function resolveThinkingProfile(context: ProviderDefaultThinkingPolicyContext) {
  const always = resolveMoonshotAlwaysThinkingEffort(
    withMoonshotThinkingFacts(context.modelId, context),
  );
  if (always) {
    const effortLevel = EFFORT_LEVELS.find((level) => level === always.effort);
    const level = effortLevel
      ? { id: effortLevel, label: effortLevel }
      : { id: "low" as const, label: "on" };
    return {
      levels: [level],
      defaultLevel: level.id,
      preserveWhenCatalogReasoningFalse: true,
    };
  }
  return {
    levels: [
      { id: "off" as const, label: "off" },
      { id: "low" as const, label: "on" },
    ],
    defaultLevel: "off" as const,
  };
}
