import { isDeepStrictEqual } from "node:util";
import { AgentHarnessPreflightError } from "openclaw/plugin-sdk/agent-harness-runtime";
import { isIncognitoSessionKey } from "openclaw/plugin-sdk/session-key-runtime";
import { codexCatalogHomeId } from "../session-catalog-home-id.js";
import { resolveCodexAppServerLocalHomeDir } from "./auth-start-options.js";
import {
  claimCodexAppServerLiveThread,
  isCodexAppServerLiveThreadClaimed,
  isCodexAppServerLiveThreadProtected,
} from "./client-runtime.js";
import { resolveCodexAppServerClientInstanceId } from "./client.js";
import {
  fingerprintCodexDynamicToolHandoffAdmission,
  buildCodexDynamicToolHandoffAdmissionConfig,
  readCodexDynamicToolHandoffV1,
  isCodexDynamicToolHandoffComplete,
  type CodexDynamicToolHandoff,
} from "./dynamic-tool-handoff.js";
import { assertCodexThreadAcceptsDirectInput } from "./protocol-validators.js";
import type { CodexTurn } from "./protocol.js";
import type { CodexAppServerThreadBinding } from "./session-binding.js";
import { retainSharedCodexAppServerClientByInstanceId } from "./shared-client.js";
import {
  buildCodexThreadBindingPolicy,
  resolveCodexThreadAgentDir,
  prepareCodexThreadFinalConfigPatch,
} from "./thread-lifecycle-preflight.js";
import type {
  CodexAppServerThreadLifecycleBinding,
  CodexStartOrResumeThreadParams,
  CodexThreadRequestContext,
} from "./thread-lifecycle-types.js";
import { isSameCodexAppServerThreadOwner } from "./thread-ownership.js";
import { listCodexUpstreamTurns } from "./upstream-fork-boundary.js";

const rejected = () =>
  new AgentHarnessPreflightError(
    "The previous Codex execution has no complete, current handoff for live recovery.",
    {
      userMessage:
        "I couldn’t safely continue the previous task. Check whether its last action completed, then reply in this thread with what still needs doing.",
    },
  );

/** Prompt provenance is not authority: only core's current custody claim admits rejoining. */
export function canAttemptCodexLiveRejoin(
  params: CodexStartOrResumeThreadParams,
  binding: CodexAppServerThreadBinding | undefined,
): boolean {
  const claim = params.params.hostCapabilities.restartRecoveryClaim;
  if (!claim) {
    return false;
  }
  claim.assertCurrent();
  if (claim.recoveryRunId !== params.params.runId) {
    throw rejected();
  }
  const handoff = readCodexDynamicToolHandoffV1(binding?.dynamicToolHandoff);
  if (handoff && handoff.sourceRunId !== claim.sourceRunId) {
    throw rejected();
  }
  // Keep ordinary orphan settlement for old bindings and incomplete callbacks.
  return Boolean(
    handoff &&
    isCodexDynamicToolHandoffComplete(handoff) &&
    params.params.hostCapabilities.registerToolHandoffSettlement,
  );
}

/** Reject unsupported ownership before lifecycle preparation can fork or reconfigure it. */
export function assertCodexLiveRejoinCandidate(
  params: CodexStartOrResumeThreadParams,
  binding: CodexAppServerThreadBinding | undefined,
): void {
  const claim = params.params.hostCapabilities.restartRecoveryClaim;
  const handoff = readCodexDynamicToolHandoffV1(binding?.dynamicToolHandoff);
  if (
    !claim ||
    params.isDynamicToolHandoffAuthorized?.() !== true ||
    !params.params.hostCapabilities.registerToolHandoffSettlement ||
    claim.recoveryRunId !== params.params.runId ||
    !binding ||
    params.appServer.start.transport !== "websocket" ||
    binding.connectionScope ||
    binding.preserveNativeModel ||
    binding.pendingResumeConfiguration ||
    binding.pendingSupervisionBranch ||
    binding.contextEngine ||
    binding.ringZeroClientInstanceId ||
    binding.ringZeroConfigFingerprint ||
    isIncognitoSessionKey(params.params.sessionKey) ||
    binding.turnRecovery?.state !== "accepted" ||
    !handoff ||
    handoff.turnId !== binding.turnRecovery.turnId ||
    handoff.sourceRunId !== claim.sourceRunId ||
    !isCodexDynamicToolHandoffComplete(handoff)
  ) {
    throw rejected();
  }
  claim.assertCurrent();
}

/** A completed status alone cannot reproduce a visible final. Keep async deliveries and
 * ambiguous or unrecognized output with their existing owner. */
export function hasCodexHandoffFinalText(
  turn: CodexTurn,
  handoff: CodexDynamicToolHandoff | undefined,
): boolean {
  if (
    !handoff ||
    turn.itemsView !== "full" ||
    turn.status !== "completed" ||
    !Array.isArray(turn.items) ||
    turn.error
  ) {
    return false;
  }
  const dynamicItems = turn.items.filter((item) => item.type === "dynamicToolCall");
  if (
    dynamicItems.length !== handoff.calls.length ||
    !handoff.calls.every(
      (call) =>
        call.state === "completed" &&
        dynamicItems.some(
          (item) =>
            item.id === call.callId &&
            item.status === "completed" &&
            item.success === call.response.success &&
            isDeepStrictEqual(item.contentItems, call.response.contentItems),
        ),
    )
  ) {
    return false;
  }
  const messages = turn.items.filter((item) => item.type === "agentMessage");
  return (
    messages.length === 1 &&
    typeof messages[0]?.text === "string" &&
    Boolean(messages[0].text.trim()) &&
    messages[0].delivery == null &&
    (messages[0].phase == null || messages[0].phase === "final_answer") &&
    turn.items.every((item) => {
      switch (item.type) {
        case "userMessage":
        case "agentMessage":
        case "reasoning":
          return true;
        case "dynamicToolCall":
          return item.status === "completed";
        default:
          return false;
      }
    })
  );
}

/** Called only after ordinary catalog and policy checks, under the binding's existing lease. */
export async function prepareCodexLiveRejoin(
  params: CodexStartOrResumeThreadParams,
  binding: CodexAppServerThreadBinding,
  context: CodexThreadRequestContext,
): Promise<CodexAppServerThreadLifecycleBinding> {
  const claim = params.params.hostCapabilities.restartRecoveryClaim;
  const handoff = readCodexDynamicToolHandoffV1(binding.dynamicToolHandoff);
  const receipt = binding.turnRecovery;
  assertCodexLiveRejoinCandidate(params, binding);
  if (
    !claim ||
    !handoff ||
    !receipt ||
    params.inferenceRoute ||
    binding.cwd !== params.cwd ||
    binding.model !== context.startModelSelection.model ||
    binding.modelProvider !== context.startModelProvider ||
    binding.authProfileId !== params.params.authProfileId
  ) {
    throw rejected();
  }
  // A loaded turn ignores resume overrides. Compare current effective policy without
  // refreshing the saved row and accidentally treating changed policy as attested.
  for (const [key, value] of Object.entries(buildCodexThreadBindingPolicy(params, context))) {
    if (!isDeepStrictEqual(binding[key as keyof CodexAppServerThreadBinding], value)) {
      throw rejected();
    }
  }
  const finalConfig = await prepareCodexThreadFinalConfigPatch(
    params,
    context.nativeModelInputTools,
    binding,
  );
  claim.assertCurrent();
  params.assertCurrent?.();
  if (
    finalConfig.nativeHookRelayGeneration !== binding.nativeHookRelayGeneration ||
    handoff.admissionFingerprint !==
      fingerprintCodexDynamicToolHandoffAdmission(
        binding,
        buildCodexDynamicToolHandoffAdmissionConfig(params.appServer, finalConfig.configPatch),
      )
  ) {
    throw rejected();
  }
  const prior = await retainSharedCodexAppServerClientByInstanceId(binding.clientId);
  const assertCurrent = () => {
    params.signal?.throwIfAborted();
    if (params.isDynamicToolHandoffAuthorized?.() !== true) {
      throw rejected();
    }
    params.params.hostCapabilities.assertActive();
    claim.assertCurrent();
    params.assertCurrent?.();
    if (
      !isSameCodexAppServerThreadOwner(params.bindingStore.read(context.bindingIdentity), binding)
    ) {
      throw rejected();
    }
  };
  try {
    assertCurrent();
    for (const client of [params.client, ...(prior ? [prior.client] : [])]) {
      if (
        isCodexAppServerLiveThreadClaimed(client, binding.threadId) ||
        isCodexAppServerLiveThreadProtected(client, binding.threadId)
      ) {
        throw rejected();
      }
    }
    if (
      (await params.bindingStore.hasOtherThreadOwner(binding.threadId, context.bindingIdentity)) ||
      !(await params.bindingStore.managedThreads?.has(
        codexCatalogHomeId(
          resolveCodexAppServerLocalHomeDir(
            params.appServer.start,
            resolveCodexThreadAgentDir(params),
          ),
        ),
        binding.threadId,
      ))
    ) {
      throw rejected();
    }
    const options = {
      signal: params.signal,
      assertCurrent,
      withCurrent: params.authority?.withCurrent,
    };
    const { thread } = await params.client.request(
      "thread/read",
      { threadId: binding.threadId, includeTurns: false },
      options,
    );
    assertCurrent();
    assertCodexThreadAcceptsDirectInput(thread);
    if (
      thread.id !== binding.threadId ||
      !["active", "idle", "notLoaded"].includes(thread.status?.type ?? "")
    ) {
      throw rejected();
    }
    const turns = await listCodexUpstreamTurns(
      {
        listTurnPage: (request) => params.client.request("thread/turns/list", request, options),
      },
      binding.threadId,
    );
    assertCurrent();
    const active = turns.filter((turn) => turn.status === "inProgress");
    const original = turns.at(-1);
    if (!original || original.id !== receipt.turnId) {
      throw rejected();
    }
    const terminalOnly = active.length === 0 && hasCodexHandoffFinalText(original, handoff);
    if (!terminalOnly) {
      if (thread.status?.type !== "active" || active.length !== 1 || active[0] !== original) {
        throw rejected();
      }
      // A tool receipt cannot restore the preceding Gateway's approval authority.
      if (thread.status.activeFlags?.includes("waitingOnApproval")) {
        throw rejected();
      }
      if (!handoff.calls.length) {
        if (
          original.itemsView !== "full" ||
          thread.status.activeFlags?.length ||
          !Array.isArray(original.items) ||
          !original.items.some((item) => item.type === "userMessage")
        ) {
          throw rejected();
        }
        const work = original.items.filter(
          (item) => item.type !== "userMessage" && item.type !== "reasoning",
        );
        if (work.length) {
          const activity = work[0];
          if (
            work.length !== 1 ||
            activity?.type !== "subAgentActivity" ||
            activity.kind !== "started" ||
            typeof activity.agentThreadId !== "string" ||
            !activity.agentThreadId ||
            activity.agentThreadId === thread.id
          ) {
            throw rejected();
          }
          // Native owns the wait. Rejoin only its parent, without attaching, spawning or sending to the child.
          const { thread: child } = await params.client.request(
            "thread/read",
            {
              threadId: activity.agentThreadId,
              includeTurns: false,
            },
            options,
          );
          assertCurrent();
          if (
            child.id !== activity.agentThreadId ||
            child.parentThreadId !== thread.id ||
            child.threadSource !== "subagent" ||
            (child.status?.type !== "active" && child.status?.type !== "idle")
          ) {
            throw rejected();
          }
        }
      }
    }
    const ownership = await claimCodexAppServerLiveThread(params.client, binding.threadId);
    if (!ownership) {
      throw rejected();
    }
    try {
      assertCurrent();
      const clientId = resolveCodexAppServerClientInstanceId(params.client);
      if (
        !(await params.bindingStore.mutate(
          context.bindingIdentity,
          {
            kind: "patch",
            threadId: binding.threadId,
            clientId: binding.clientId,
            patch: { clientId },
          },
          assertCurrent,
          params.authority,
        ))
      ) {
        throw rejected();
      }
      claim.assertCurrent();
      return {
        ...binding,
        clientId,
        liveThreadOwnership: ownership,
        lifecycle: {
          action: "resumed",
          rejoinedTurn: {
            turnId: receipt.turnId,
            sourceRunId: claim.sourceRunId,
            ...(terminalOnly ? { terminalOnly: true } : {}),
          },
        },
      };
    } catch (error) {
      ownership.forget();
      throw error;
    }
  } finally {
    await prior?.release();
  }
}
