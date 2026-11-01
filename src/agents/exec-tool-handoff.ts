import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveExecModePolicy } from "../infra/exec-approvals-core.js";
import { resolveExecApprovalsFromFileInternal as resolveExecApprovalsFromFile } from "../infra/exec-approvals-resolver.js";
import { loadExecApprovalsReadOnly } from "../infra/exec-approvals-store.js";
import { parseAgentSessionKey, resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { isSecretEgressProxyActive } from "../secrets/egress-proxy/registry.js";
import { resolveClientVoiceRunBinding } from "../talk/client-voice-session.js";
import { hasBeforeToolCallPolicy } from "./agent-tools.before-tool-call.policy.js";
import type { ExecToolDefaults } from "./bash-tools.exec-types.js";

/** Only unrestricted Gateway exec has a pure current-authority check in handoff v1. */
export function createExecResultHandoffAuthorizer(defaults?: ExecToolDefaults) {
  const usesSecretEgress = isSecretEgressProxyActive();
  return (args: unknown): boolean => {
    const params = asNonArrayRecord(args);
    // Approval grants, sandbox/node targets and elevated/session bypasses are not portable.
    // The host-owned projection supplies the pinned gateway target before this check.
    if (
      params.host !== "gateway" ||
      (defaults?.host !== undefined && defaults.host !== "auto" && defaults.host !== "gateway") ||
      params.elevated === true ||
      params.background === true ||
      defaults?.sandbox ||
      defaults?.sandboxRequired ||
      defaults?.bypassHostApprovalFloors ||
      (defaults?.elevated?.enabled &&
        defaults.elevated.allowed &&
        defaults.elevated.defaultLevel !== "off") ||
      usesSecretEgress ||
      isSecretEgressProxyActive() ||
      hasBeforeToolCallPolicy() ||
      resolveClientVoiceRunBinding(defaults?.runId)
    ) {
      return false;
    }
    const policy = resolveExecModePolicy({
      mode: defaults?.mode,
      security: defaults?.security ?? "full",
      ask: defaults?.ask ?? "off",
    });
    if (
      policy.security !== "full" ||
      policy.ask !== "off" ||
      policy.autoReview ||
      (params.ask !== undefined && params.ask !== "off")
    ) {
      return false;
    }
    const parsedSession = parseAgentSessionKey(defaults?.sessionKey);
    const agentId =
      defaults?.agentId ??
      (parsedSession ? resolveAgentIdFromSessionKey(defaults?.sessionKey) : undefined);
    try {
      // Re-read the actual policy owner for every replay; schema/config snapshots cannot
      // attest that a durable host approval floor has not tightened since the effect.
      const current = resolveExecApprovalsFromFile({
        file: loadExecApprovalsReadOnly(),
        agentId,
        overrides: { security: "full", ask: "off" },
      }).agent;
      return current.security === "full" && current.ask === "off";
    } catch {
      return false;
    }
  };
}
