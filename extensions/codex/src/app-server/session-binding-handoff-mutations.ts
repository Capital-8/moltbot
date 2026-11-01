/** Journal transitions run only inside the existing binding owner's transaction. */
import {
  CODEX_DYNAMIC_TOOL_HANDOFF_MAX_BYTES,
  CODEX_DYNAMIC_TOOL_HANDOFF_MAX_CALLS,
  codexDynamicToolHandoffRequestIdentity,
  fingerprintCodexDynamicToolHandoffAdmission,
  readCodexDynamicToolHandoffV1,
  type CodexDynamicToolHandoff,
  type CodexDynamicToolHandoffRequest,
  type CodexDynamicToolHandoffResponse,
} from "./dynamic-tool-handoff.js";
import type { JsonObject } from "./protocol.js";
import {
  ownsStoredSessionGeneration,
  type CodexAppServerBindingIdentity,
  type StoredCodexAppServerBinding,
} from "./session-binding-record.js";

export type CodexDynamicToolHandoffMutation = {
  kind: "dynamic-tool-handoff";
  threadId: string;
  clientId: string | undefined;
  turnId: string;
  sourceRunId: string;
  nativeHookConfig?: JsonObject;
  operation:
    | {
        kind: "begin";
        admissionFingerprint: string;
        pending?: ReturnType<typeof codexDynamicToolHandoffRequestIdentity>[];
      }
    | { kind: "started"; request: CodexDynamicToolHandoffRequest }
    | {
        kind: "completed";
        request: CodexDynamicToolHandoffRequest;
        response: CodexDynamicToolHandoffResponse;
      }
    | { kind: "unsupported"; request: CodexDynamicToolHandoffRequest }
    | { kind: "clear" };
};

export function mutateCodexDynamicToolHandoffBinding({
  identity,
  current,
  mutation,
  assertCurrent,
}: {
  identity: CodexAppServerBindingIdentity;
  current: StoredCodexAppServerBinding | undefined;
  mutation: CodexDynamicToolHandoffMutation;
  assertCurrent: (() => void) | undefined;
}): { result: boolean; next?: StoredCodexAppServerBinding } {
  if (!assertCurrent) {
    throw new Error("Codex tool handoff mutation requires current authority.");
  }
  assertCurrent();
  if (
    current?.state !== "active" ||
    !ownsStoredSessionGeneration(identity, current) ||
    current.binding.threadId !== mutation.threadId ||
    current.binding.clientId !== mutation.clientId
  ) {
    return { result: false };
  }
  const binding = current.binding;
  const operation = mutation.operation;
  const prior = readCodexDynamicToolHandoffV1(binding.dynamicToolHandoff);
  if (operation.kind === "clear") {
    if (
      !prior ||
      prior.turnId !== mutation.turnId ||
      prior.sourceRunId !== mutation.sourceRunId ||
      binding.turnRecovery !== undefined
    ) {
      return { result: false };
    }
    const nextBinding = { ...binding };
    delete nextBinding.dynamicToolHandoff;
    assertCurrent();
    return {
      result: true,
      next: { ...current, binding: nextBinding },
    };
  }
  if (
    binding.turnRecovery?.turnId !== mutation.turnId ||
    binding.turnRecovery.state !== "accepted"
  ) {
    return { result: false };
  }
  let next: CodexDynamicToolHandoff;
  if (operation.kind === "begin") {
    if (
      operation.admissionFingerprint !==
      fingerprintCodexDynamicToolHandoffAdmission(binding, mutation.nativeHookConfig)
    ) {
      return { result: false };
    }
    const pending = operation.pending ?? [];
    if (
      binding.dynamicToolHandoff !== undefined ||
      pending.length > CODEX_DYNAMIC_TOOL_HANDOFF_MAX_CALLS
    ) {
      return { result: false };
    }
    next = {
      version: 1,
      coverage: "all-dynamic-tools",
      turnId: mutation.turnId,
      sourceRunId: mutation.sourceRunId,
      admissionFingerprint: operation.admissionFingerprint,
      // Publish the initial record and all pre-drain in-flight calls in one transaction.
      calls: pending.map(({ callId, requestId, requestFingerprint }) => ({
        callId,
        requestId,
        requestFingerprint,
        state: "started",
      })),
    };
  } else {
    if (
      !prior ||
      prior.turnId !== mutation.turnId ||
      prior.sourceRunId !== mutation.sourceRunId ||
      prior.admissionFingerprint !==
        fingerprintCodexDynamicToolHandoffAdmission(binding, mutation.nativeHookConfig) ||
      operation.request.call.threadId !== mutation.threadId ||
      operation.request.call.turnId !== mutation.turnId
    ) {
      return { result: false };
    }
    const request = codexDynamicToolHandoffRequestIdentity(operation.request);
    const index = prior.calls.findIndex(
      (call) => call.callId === request.callId || call.requestId === request.requestId,
    );
    if (operation.kind === "started") {
      if (index !== -1) {
        return { result: false };
      }
      next =
        prior.calls.length >= CODEX_DYNAMIC_TOOL_HANDOFF_MAX_CALLS || prior.unsupported
          ? { ...prior, unsupported: true }
          : { ...prior, calls: [...prior.calls, { ...request, state: "started" }] };
    } else {
      // Overflowed turns keep running live, but cannot certify any recovery.
      if (prior.unsupported && index === -1) {
        return { result: true };
      }
      const call = prior.calls[index];
      if (
        !call ||
        call.state !== "started" ||
        call.callId !== request.callId ||
        call.requestId !== request.requestId ||
        call.requestFingerprint !== request.requestFingerprint
      ) {
        return { result: false };
      }
      next = {
        ...prior,
        calls: prior.calls.map((entry, i) =>
          i !== index
            ? entry
            : operation.kind === "completed"
              ? { ...request, state: "completed", response: operation.response }
              : { ...request, state: "unsupported" },
        ),
      };
    }
  }
  if (Buffer.byteLength(JSON.stringify(next)) > CODEX_DYNAMIC_TOOL_HANDOFF_MAX_BYTES - 32) {
    // Keep the existing evidence. Never truncate a replayable result or evict an unknown call.
    if (!prior) {
      return { result: false };
    }
    next = { ...prior, unsupported: true };
  }
  if (!readCodexDynamicToolHandoffV1(next)) {
    return { result: false };
  }
  assertCurrent();
  return { result: true, next: { ...current, binding: { ...binding, dynamicToolHandoff: next } } };
}
