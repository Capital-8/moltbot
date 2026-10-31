import { afterEach, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { projectConfigOntoRuntimeSourceSnapshot } from "../config/runtime-source-projection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizePreparedModelRuntimeInput } from "./prepared-model-runtime.owner.js";

afterEach(() => clearRuntimeConfigSnapshot());

const ref = { source: "env" as const, provider: "default", id: "PLUGIN_KEY" };
const pluginConfig = (apiKey: unknown) =>
  ({
    plugins: { entries: { secretful: { enabled: true, config: { apiKey } } } },
  }) as OpenClawConfig;

it("keeps the admitted authored source after a newer config generation publishes", () => {
  const admitted = pluginConfig("resolved-key");
  setRuntimeConfigSnapshot(admitted, pluginConfig(ref));
  const input = normalizePreparedModelRuntimeInput({
    agentId: "main",
    agentDir: "/tmp/agent",
    config: admitted,
  } as never);
  expect(input.config).toBe(admitted);
  // A later config write adds top-level metadata the admitted config never had.
  setRuntimeConfigSnapshot(
    { ...pluginConfig("resolved-key"), meta: { lastTouchedVersion: "x" } } as OpenClawConfig,
    { ...pluginConfig(ref), meta: { lastTouchedVersion: "x" } } as OpenClawConfig,
  );
  expect(
    projectConfigOntoRuntimeSourceSnapshot(input.config).plugins?.entries?.secretful?.config,
  ).toEqual({ apiKey: ref });
});
