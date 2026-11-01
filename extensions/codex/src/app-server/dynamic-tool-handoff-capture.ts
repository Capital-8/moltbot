import { isIncognitoSessionKey } from "openclaw/plugin-sdk/session-key-runtime";
import {
  CODEX_DYNAMIC_TOOL_HANDOFF_MAX_CALLS,
  buildCodexDynamicToolHandoffAdmissionConfig,
  codexDynamicToolHandoffRequestIdentity,
  fingerprintCodexDynamicToolHandoffAdmission,
  readCodexDynamicToolHandoffResponse,
  readCodexDynamicToolHandoffV1,
  type CodexDynamicToolHandoffRequest,
} from "./dynamic-tool-handoff.js";
import type { CodexDynamicToolRuntimeResponse } from "./dynamic-tool-response-state.js";
import type { CodexAttemptResources } from "./run-attempt-resources.js";
import type { CodexDynamicToolHandoffMutation } from "./session-binding-handoff-mutations.js";
import { CodexThreadBindingConflictError } from "./thread-lifecycle-errors.js";

async function commit(
  resources: CodexAttemptResources,
  turnId: string,
  operation: CodexDynamicToolHandoffMutation["operation"],
  assertCurrent: () => void,
) {
  const { connection } = resources.prompt.context.runtime;
  const { thread } = resources.state;
  const rejoined = thread.lifecycle.rejoinedTurn;
  const sourceRunId = rejoined?.sourceRunId ?? connection.params.runId;
  const assertOwner = () => {
    assertCurrent();
    connection.params.hostCapabilities.assertActive();
    if (rejoined) {
      const claim = connection.params.hostCapabilities.restartRecoveryClaim;
      if (
        !claim ||
        claim.sourceRunId !== sourceRunId ||
        claim.recoveryRunId !== connection.params.runId
      ) {
        throw new Error("Codex tool handoff lost its original task claim");
      }
      claim.assertCurrent();
    }
  };
  assertOwner();
  const applied = await connection.bindingStore.mutate(
    connection.bindingIdentity,
    {
      kind: "dynamic-tool-handoff",
      threadId: thread.threadId,
      clientId: thread.clientId,
      turnId,
      sourceRunId,
      nativeHookConfig: buildCodexDynamicToolHandoffAdmissionConfig(
        connection.appServer,
        resources.state.nativeHookRelayConfigPatch,
      ),
      operation,
    },
    assertOwner,
    connection.authority,
  );
  assertOwner();
  if (!applied) {
    throw new CodexThreadBindingConflictError(thread.threadId, "recording dynamic tool handoff");
  }
  thread.dynamicToolHandoff = connection.bindingStore.read(
    connection.bindingIdentity,
  )?.dynamicToolHandoff;
}

/** Before drain keep only identities of currently open callbacks. No results or completed history. */
export type CodexPlannedToolHandoff = {
  turnId: string;
  pending: Map<string | number, ReturnType<typeof codexDynamicToolHandoffRequestIdentity>>;
  opening?: Promise<void>;
  detach: () => void;
};

export async function beginCodexDynamicToolHandoff(
  resources: CodexAttemptResources,
  turnId: string,
  assertCurrent: () => void,
): Promise<void> {
  const { connection } = resources.prompt.context.runtime;
  const { thread } = resources.state;
  const { toolHandoffDrainSignal: drain, registerToolHandoffSettlement } =
    connection.params.hostCapabilities;
  resources.state.plannedToolHandoff?.detach();
  if (
    !drain ||
    !registerToolHandoffSettlement ||
    thread.dynamicToolHandoff !== undefined ||
    connection.appServer.start.transport !== "websocket" ||
    thread.lifecycle.preserveExistingBinding ||
    thread.connectionScope ||
    thread.preserveNativeModel ||
    thread.contextEngine ||
    thread.pendingResumeConfiguration ||
    thread.ringZeroClientInstanceId ||
    thread.ringZeroConfigFingerprint ||
    isIncognitoSessionKey(connection.params.sessionKey)
  ) {
    return;
  }
  const readAcceptedOwner = () => {
    assertCurrent();
    connection.params.hostCapabilities.assertActive();
    const binding = connection.bindingStore.read(connection.bindingIdentity);
    if (
      !binding ||
      binding.threadId !== thread.threadId ||
      binding.clientId !== thread.clientId ||
      binding.turnRecovery?.turnId !== turnId ||
      binding.turnRecovery.state !== "accepted"
    ) {
      throw new CodexThreadBindingConflictError(thread.threadId, "starting dynamic tool handoff");
    }
    return binding;
  };
  // Compare the policy that originally admitted this turn with the one in the drain transaction.
  const accepted = readAcceptedOwner();
  const config = buildCodexDynamicToolHandoffAdmissionConfig(
    connection.appServer,
    resources.state.nativeHookRelayConfigPatch,
  );
  const plan: CodexPlannedToolHandoff = {
    turnId,
    pending: new Map(),
    detach() {
      drain.removeEventListener("abort", onDrain);
      plan.pending.clear();
      if (resources.state.plannedToolHandoff === plan) {
        resources.state.plannedToolHandoff = undefined;
      }
    },
  };
  const open = async () => {
    const pending = Array.from(plan.pending.values());
    plan.pending.clear();
    try {
      await commit(
        resources,
        turnId,
        {
          kind: "begin",
          admissionFingerprint: fingerprintCodexDynamicToolHandoffAdmission(accepted, config),
          pending,
        },
        assertCurrent,
      );
    } catch (error) {
      // Only a positively absent journal can fall back to ordinary live execution.
      if (readAcceptedOwner().dynamicToolHandoff === undefined) {
        plan.detach();
        return;
      }
      throw error;
    }
    registerCodexDynamicToolHandoffSettlement(resources, turnId);
  };
  function onDrain() {
    plan.opening = open();
    // The signal has no async caller. Tool dispatch/completion joins this same barrier.
    void plan.opening.catch(() => {});
  }
  resources.state.plannedToolHandoff = plan;
  if (drain.aborted) {
    onDrain();
    await plan.opening;
  } else {
    drain.addEventListener("abort", onDrain, { once: true });
  }
}

/** Must complete durably before hooks, tools, or their side effects are dispatched. */
export async function recordCodexDynamicToolHandoffStarted(
  resources: CodexAttemptResources,
  request: CodexDynamicToolHandoffRequest,
  assertCurrent: () => void,
): Promise<void> {
  const plan = resources.state.plannedToolHandoff;
  if (plan?.turnId === request.call.turnId) {
    if (!plan.opening) {
      if (
        plan.pending.size >= CODEX_DYNAMIC_TOOL_HANDOFF_MAX_CALLS ||
        plan.pending.has(request.requestId)
      ) {
        plan.detach();
      } else {
        plan.pending.set(request.requestId, codexDynamicToolHandoffRequestIdentity(request));
      }
      return;
    }
    await plan.opening;
  }
  if (!hasCurrentCodexDynamicToolHandoff(resources, request.call.turnId)) {
    return;
  }
  await commit(resources, request.call.turnId, { kind: "started", request }, assertCurrent);
}

/** Only the original producer can attest completion; fallback/timeouts have no attestation. */
export async function recordCodexDynamicToolHandoffResult(
  resources: CodexAttemptResources,
  request: CodexDynamicToolHandoffRequest,
  response: CodexDynamicToolRuntimeResponse,
  assertCurrent: () => void,
): Promise<void> {
  const plan = resources.state.plannedToolHandoff;
  if (plan?.turnId === request.call.turnId) {
    if (!plan.opening) {
      // An ordinary completed call has no original handoff attestation. A later
      // partial journal must never certify that unrecorded calls were not run.
      plan.detach();
      return;
    }
    await plan.opening;
  }
  if (!hasCurrentCodexDynamicToolHandoff(resources, request.call.turnId)) {
    return;
  }
  const protocolResponse = readCodexDynamicToolHandoffResponse({
    success: response.success,
    contentItems: response.contentItems,
  });
  await commit(
    resources,
    request.call.turnId,
    response.handoffDisposition === "eligible" && protocolResponse
      ? { kind: "completed", request, response: protocolResponse }
      : { kind: "unsupported", request },
    assertCurrent,
  );
}

/** Old journals never backfill a new turn's coverage or block an unrelated ordinary turn. */
export function hasCurrentCodexDynamicToolHandoff(
  resources: CodexAttemptResources,
  turnId: string,
): boolean {
  if (resources.state.thread.dynamicToolHandoff === undefined) {
    return false;
  }
  const record = readCodexDynamicToolHandoffV1(resources.state.thread.dynamicToolHandoff);
  return Boolean(
    record &&
    record.turnId === turnId &&
    record.sourceRunId ===
      (resources.state.thread.lifecycle.rejoinedTurn?.sourceRunId ??
        resources.prompt.context.runtime.connection.params.runId),
  );
}

/** Register while the attempt is active; cleanup uses the command owner's later live custody. */
export function registerCodexDynamicToolHandoffSettlement(
  resources: CodexAttemptResources,
  turnId: string,
): void {
  const { connection } = resources.prompt.context.runtime;
  const record = readCodexDynamicToolHandoffV1(resources.state.thread.dynamicToolHandoff);
  if (!record || record.turnId !== turnId) {
    return;
  }
  const { threadId, clientId } = resources.state.thread;
  const { bindingStore, bindingIdentity } = connection;
  const { sourceRunId } = record;
  connection.params.hostCapabilities.registerToolHandoffSettlement?.(async (assertCurrent) => {
    assertCurrent();
    // The binding owner separately requires native terminal and exact generation/turn/source.
    // A closed plugin host cannot authorize this write; the command still owns final custody.
    await bindingStore.mutate(
      bindingIdentity,
      {
        kind: "dynamic-tool-handoff",
        threadId,
        clientId,
        turnId,
        sourceRunId,
        operation: { kind: "clear" },
      },
      assertCurrent,
    );
    assertCurrent();
  });
}
