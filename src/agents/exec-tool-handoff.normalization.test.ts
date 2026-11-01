import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { saveExecApprovals } from "../infra/exec-approvals-store.test-support.js";
import { normalizeOpenAIToolSchemas } from "../plugin-sdk/provider-tools.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import {
  copyNormalizedGatewayExecHandoff,
  createCronScheduledToolProjection,
  isGatewayExecResultHandoffAuthorized,
  readCronScheduledToolProjection,
} from "./exec-tool-target-pinning.js";
import { createLazyExecTool } from "./lazy-exec-tool.js";
import { normalizeAgentRuntimeTools } from "./runtime-plan/tools.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let previousStateDir: string | undefined;
beforeEach(() => {
  previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = path.join(tempDirs.make("normalized-exec-handoff-"), "state");
  saveExecApprovals({ version: 1, defaults: { security: "full", ask: "off" }, agents: {} });
});
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  if (previousStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = previousStateDir;
  }
});

describe("Gateway exec handoff through the provider normalization owner", () => {
  it("preserves only exact active normalizer delegation, without granting cron alias authority", async () => {
    const record = createPluginRecord({ id: "handoff-normalizer", origin: "bundled" });
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(record);
    const instance = new PluginInstance(record.id, { record, registry });
    // The production provider registrar marks schema normalization as a factory.
    instance.admitFactory(normalizeOpenAIToolSchemas);
    const provider = instance.wrap({
      id: "openai",
      label: "OpenAI",
      auth: [],
      normalizeToolSchemas: normalizeOpenAIToolSchemas,
    });
    try {
      const exec = wrapToolWithBeforeToolCallHook(
        createLazyExecTool({
          host: "gateway",
          security: "full",
          ask: "off",
          agentId: "main",
        }),
      );
      const alias = createCronScheduledToolProjection(exec, () => {}, "exec", {
        kind: "exec",
        name: "gateway_exec",
        description: "Gateway exec",
        followupText: "done",
      });
      const normalized = normalizeAgentRuntimeTools({
        tools: [alias],
        provider: "openai",
        modelApi: "openai-responses",
        runtimeHandle: { provider: "openai", plugin: provider },
        allowProviderRuntimePluginLoad: false,
      })[0]!;
      expect(normalized.execute).not.toBe(alias.execute);
      expect(isGatewayExecResultHandoffAuthorized(normalized, {})).toBe(true);
      expect(readCronScheduledToolProjection(normalized)).toBeUndefined();

      const arbitrary = { ...normalized, execute: async () => ({ content: [], details: {} }) };
      copyNormalizedGatewayExecHandoff(alias, arbitrary);
      expect(isGatewayExecResultHandoffAuthorized(arbitrary, {})).toBe(false);
      const changedChecker = { ...normalized, isCompletedResultHandoffAuthorized: () => true };
      copyNormalizedGatewayExecHandoff(alias, changedChecker);
      expect(isGatewayExecResultHandoffAuthorized(changedChecker, {})).toBe(false);
      const unrelated = instance.wrap({ execute: async () => ({ content: [], details: {} }) });
      const unrelatedExecutor = { ...normalized, execute: unrelated.execute };
      copyNormalizedGatewayExecHandoff(alias, unrelatedExecutor);
      expect(isGatewayExecResultHandoffAuthorized(unrelatedExecutor, {})).toBe(false);

      saveExecApprovals({ version: 1, defaults: { security: "deny", ask: "off" }, agents: {} });
      expect(isGatewayExecResultHandoffAuthorized(normalized, {})).toBe(false);
      saveExecApprovals({ version: 1, defaults: { security: "full", ask: "off" }, agents: {} });
      expect(isGatewayExecResultHandoffAuthorized(normalized, {})).toBe(true);
      await instance.dispose();
      expect(() => isGatewayExecResultHandoffAuthorized(normalized, {})).toThrow();
    } finally {
      await instance.dispose();
    }
  });
});
