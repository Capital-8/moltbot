import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { saveExecApprovals } from "../infra/exec-approvals-store.test-support.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import type { ExecToolDefaults } from "./bash-tools.exec-types.js";
import {
  createCronScheduledToolProjection,
  isGatewayExecResultHandoffAuthorized,
} from "./exec-tool-target-pinning.js";
import { createLazyExecTool } from "./lazy-exec-tool.js";

const hooks = vi.hoisted(() => ({ hasHooks: vi.fn(() => false), secretEgress: false }));
vi.mock("../secrets/egress-proxy/registry.js", () => ({
  isSecretEgressProxyActive: () => hooks.secretEgress,
}));
vi.mock("../plugins/hook-runner-global.js", () => ({ getGlobalHookRunner: () => hooks }));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let root: string;
beforeEach(() => {
  root = tempDirs.make("exec-result-handoff-");
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
  hooks.hasHooks.mockReturnValue(false);
  hooks.secretEgress = false;
  saveExecApprovals({ version: 1, defaults: { security: "full", ask: "off" }, agents: {} });
});
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});
function projection(defaults: ExecToolDefaults = {}, ask?: "always") {
  const tool = wrapToolWithBeforeToolCallHook(
    createLazyExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      agentId: "main",
      ...defaults,
    }),
  );
  return createCronScheduledToolProjection(tool, () => {}, "exec", {
    kind: "exec",
    name: "gateway_exec",
    description: "Gateway exec",
    followupText: "done",
    ask,
  });
}

describe("completed Gateway exec result current authority", () => {
  it("uses the actual current host approval floor without executing or consuming an approval", () => {
    const tool = projection();
    const args = { command: "printf existing-result" };
    expect(isGatewayExecResultHandoffAuthorized(tool, args)).toBe(true);
    saveExecApprovals({
      version: 1,
      defaults: { security: "full", ask: "off" },
      agents: { main: { security: "deny" } },
    });
    expect(isGatewayExecResultHandoffAuthorized(tool, args)).toBe(false);
    saveExecApprovals({ version: 1, defaults: { security: "full", ask: "always" }, agents: {} });
    expect(isGatewayExecResultHandoffAuthorized(tool, args)).toBe(false);
  });
  it.each<ExecToolDefaults>([
    { host: "node" },
    { host: "sandbox" },
    { security: "allowlist" },
    { ask: "always" },
    { mode: "auto" },
    { mode: "ask" },
    { mode: "deny" },
    { mode: "allowlist" },
    { sandboxRequired: true },
    { bypassHostApprovalFloors: true },
    { elevated: { enabled: true, allowed: true, defaultLevel: "full" } },
  ])("rejects nonportable exec policy %j even with identical schema", (defaults) => {
    const full = projection();
    const restricted = projection(defaults);
    expect(restricted.parameters).toEqual(full.parameters);
    expect(isGatewayExecResultHandoffAuthorized(restricted, { command: "echo saved" })).toBe(false);
  });
  it("honors the alias's pinned ask and never trusts a same-name object", () => {
    const tool = projection();
    expect(isGatewayExecResultHandoffAuthorized({ ...tool }, {})).toBe(false);
    expect(isGatewayExecResultHandoffAuthorized(projection({}, "always"), {})).toBe(false);
    expect(isGatewayExecResultHandoffAuthorized(tool, { elevated: true })).toBe(false);
    expect(isGatewayExecResultHandoffAuthorized(tool, { background: true })).toBe(false);
    tool.isCompletedResultHandoffAuthorized = () => true;
    expect(isGatewayExecResultHandoffAuthorized(tool, {})).toBe(false);
  });
  it("excludes Secret Store egress grants from the unrestricted exec domain", () => {
    const tool = projection();
    expect(isGatewayExecResultHandoffAuthorized(tool, {})).toBe(true);
    hooks.secretEgress = true;
    expect(isGatewayExecResultHandoffAuthorized(tool, {})).toBe(false);
  });
  it("refuses a newly registered before-tool policy without invoking it", () => {
    const tool = projection();
    expect(isGatewayExecResultHandoffAuthorized(tool, {})).toBe(true);
    hooks.hasHooks.mockReturnValue(true);
    expect(isGatewayExecResultHandoffAuthorized(tool, {})).toBe(false);
  });
});
