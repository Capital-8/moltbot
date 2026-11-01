// Applies configure model selections to an existing model allowlist.
import { DEFAULT_PROVIDER } from "../agents/defaults.js";
import {
  LEGACY_MODEL_POLICY_ALLOW_CONFIG_PATH,
  resolveConfiguredModelPolicyAllow,
} from "../agents/model-selection-shared.js";
import {
  buildModelAliasIndex,
  modelKey,
  normalizeProviderId,
  resolveModelRefFromString,
} from "../agents/model-selection.js";
import { normalizeAgentModelRefForConfig } from "../config/model-input.js";
import { parseModelPolicyWildcardRef } from "../config/model-policy-ref.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export function normalizeModelKeys(values: string[]): string[] {
  return [...new Set(Array.from(values, normalizeAgentModelRefForConfig).filter(Boolean))];
}

/**
 * Applies a configure-picker selection to the default model allowlist.
 * Configure never creates an allowlist: without one, models of providers with
 * auth already show. With one, the scoped provider's refs are replaced by the
 * selection. Selecting every model of a complete provider catalog keeps it dynamic
 * as `<provider>/*`; a partial scope (offered or configured models only) stays exact.
 */
export function applyModelAllowlist(
  cfg: OpenClawConfig,
  models: string[],
  opts: { scopeKeys?: string[]; scopeComplete?: boolean } = {},
): OpenClawConfig {
  const defaults = cfg.agents?.defaults;
  const policy = resolveConfiguredModelPolicyAllow({ cfg });
  if (policy.refs.length === 0) {
    return cfg;
  }
  const normalized = normalizeModelKeys(models);
  const scopeKeys = opts.scopeKeys ? normalizeModelKeys(opts.scopeKeys) : [];
  const scopeKeySet = scopeKeys.length > 0 ? new Set(scopeKeys) : null;
  const existingAllow = normalizeModelKeys([...policy.refs]);
  const providerOf = (key: string) => normalizeProviderId(key.slice(0, key.indexOf("/")));
  const scopeProviders = new Set(scopeKeys.map(providerOf));
  const aliasIndex = buildModelAliasIndex({ cfg, defaultProvider: DEFAULT_PROVIDER });
  const isPolicyRefInScope = (raw: string): boolean => {
    const wildcard = parseModelPolicyWildcardRef(raw);
    if (wildcard) {
      return scopeProviders.has(wildcard.provider);
    }
    const resolved = resolveModelRefFromString({
      cfg,
      raw: raw.trim(),
      defaultProvider: DEFAULT_PROVIDER,
      aliasIndex,
    });
    return Boolean(
      resolved && scopeKeySet?.has(modelKey(resolved.ref.provider, resolved.ref.model)),
    );
  };
  let nextAllow: string[];
  if (!scopeKeySet) {
    nextAllow = normalized;
  } else {
    const selected = new Set(normalized);
    nextAllow = existingAllow.filter((key) => !isPolicyRefInScope(key));
    for (const provider of scopeProviders) {
      const providerScope = scopeKeys.filter((key) => providerOf(key) === provider);
      const picks = providerScope.filter((key) => selected.has(key));
      // Every model of the provider selected: keep newly released models visible too.
      const refs =
        opts.scopeComplete && picks.length === providerScope.length ? [`${provider}/*`] : picks;
      for (const ref of refs) {
        if (!nextAllow.includes(ref)) {
          nextAllow.push(ref);
        }
      }
    }
  }
  if (nextAllow.length === 0 && policy.configPath !== LEGACY_MODEL_POLICY_ALLOW_CONFIG_PATH) {
    // An empty allowlist is no restriction. A legacy map instead needs the explicit
    // empty policy, or the map would keep restricting.
    const { modelPolicy: _removed, ...rest } = defaults ?? {};
    return { ...cfg, agents: { ...cfg.agents, defaults: rest } };
  }
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: { ...defaults, modelPolicy: { ...defaults?.modelPolicy, allow: nextAllow } },
    },
  };
}
