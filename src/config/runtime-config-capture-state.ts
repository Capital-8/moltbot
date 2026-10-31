import { freezeJsonSnapshot, isDeeplyFrozenPlainData } from "../shared/immutable-data.js";
import { cloneConfigWithResolutionFacts, getConfigResolutionFacts } from "./resolution-facts.js";
import type { OpenClawConfig } from "./types.openclaw.js";

type RuntimeConfigCapture = Readonly<{
  source: OpenClawConfig;
  origin: OpenClawConfig;
}>;

const captures = new WeakMap<OpenClawConfig, RuntimeConfigCapture>();
const immutableCaptures = new WeakMap<OpenClawConfig, OpenClawConfig>();

export function getRuntimeConfigCapture(
  config: OpenClawConfig | undefined,
): RuntimeConfigCapture | undefined {
  return config ? captures.get(config) : undefined;
}

const pinnedSources = new WeakMap<OpenClawConfig, OpenClawConfig>();

/**
 * Record the authored source of a published runtime config without cloning it, so later
 * projection uses this generation instead of a newer source snapshot. Unlike a capture,
 * the config stays mutable: callers that need an isolated pair still capture it.
 */
export function pinRuntimeConfigSource(config: OpenClawConfig, source: OpenClawConfig): void {
  if (!pinnedSources.has(config)) {
    pinnedSources.set(config, source);
  }
}

export function getPinnedRuntimeConfigSource(
  config: OpenClawConfig | undefined,
): OpenClawConfig | undefined {
  return config ? pinnedSources.get(config) : undefined;
}

/** Freeze a selected runtime/source pair before its publication owner yields. */
export function captureRuntimeConfigWithSource(
  config: OpenClawConfig,
  source: OpenClawConfig,
): OpenClawConfig {
  // Only a source-free immutable input has no mutable publication context to capture.
  const reusable = config === source && isDeeplyFrozenPlainData(config);
  const previous = reusable ? immutableCaptures.get(config) : undefined;
  if (previous && getConfigResolutionFacts(previous) === getConfigResolutionFacts(config)) {
    return previous;
  }
  const clone = (value: OpenClawConfig) =>
    freezeJsonSnapshot(cloneConfigWithResolutionFacts(value));
  const captured = clone(config);
  const capturedSource = source === config ? captured : clone(source);
  captures.set(captured, {
    source: capturedSource,
    origin: config,
  });
  if (capturedSource !== captured) {
    captures.set(capturedSource, {
      source: capturedSource,
      origin: source,
    });
  }
  if (reusable) {
    immutableCaptures.set(config, captured);
  }
  return captured;
}

export type CapturedRuntimeConfigRead = { config: OpenClawConfig; env: NodeJS.ProcessEnv };
