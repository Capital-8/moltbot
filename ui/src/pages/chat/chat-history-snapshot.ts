import {
  readSessionMessageIdentity,
  reduceSessionProjection,
} from "@openclaw/gateway-client/browser";
import { asSafeIntegerInRange } from "@openclaw/normalization-core/number-coercion";
import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import type {
  ChatInputReceipts,
  ChatPendingInputsPage,
  ChatHistoryActivity,
  ChatHistoryDeltaResult as ProtocolChatHistoryDeltaResult,
  ChatHistoryResetResult,
} from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { GatewaySessionRow, GatewaySessionsDefaults } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import type { ChatMetadataResult } from "../../lib/chat/chat-metadata-cache.ts";
import {
  nativeHistoryMessageIdentity,
  nativeHistoryMessageSourceIdentity,
  prependUniqueNativeMessages,
} from "../../lib/chat/history-message-identity.ts";
import {
  isUiSelectedGlobalSessionKey,
  resolveUiSelectedSessionAgentId,
} from "../../lib/sessions/session-key.ts";
import type { ChatHistoryPagination } from "./chat-history-pagination.ts";
import {
  chatHistoryWindowBoundary,
  extendChatHistoryWindow,
  selectChatHistoryResidency,
} from "./chat-history-window.ts";
import { projectChatSessionStateSnapshot } from "./chat-session-state-snapshot.ts";
import type { ChatHistorySessions, ChatState } from "./chat-state-contract.ts";
import type { ChatHistoryState } from "./chat-transcript-metadata.ts";
import {
  getChatSessionProjection,
  publishChatSessionProjection,
  publishChatSessionProjectionMessages,
  retireChatSubmissionDisplay,
} from "./history-merge.ts";
import type { ChatHistoryRunObservation } from "./run-lifecycle.ts";
import {
  cacheChatSessionSnapshot,
  readChatSessionSnapshot,
  readChatHistoryCursor,
  setChatHistoryCursor,
  projectChatTranscriptMetadata,
} from "./session-message-cache.ts";
import type { AgentEventPayload } from "./tool-stream-contract.ts";

export type ChatHistoryResult = {
  stateRevision?: ChatHistoryState["stateRevision"];
  activity?: ChatHistoryActivity[];
  pendingInputs?: ChatPendingInputsPage;
  inputReceipts?: ChatInputReceipts;
  deltaCursor?: string;
  windowReset?: boolean;
  messages?: Array<unknown>;
  offset?: number;
  nextOffset?: number;
  olderCursor?: string;
  newerCursor?: string;
  hasMore?: boolean;
  totalMessages?: number;
  completeSnapshot?: boolean;
  sessionId?: string;
  thinkingLevel?: string;
  verboseLevel?: string;
  defaults?: GatewaySessionsDefaults;
  sessionInfo?: GatewaySessionRow;
  sessionInfoSnapshotAt?: number;
  metadata?: Partial<ChatMetadataResult>;
  inFlightRun?: {
    runId: string;
    text?: string;
    startedAt?: number;
    sessionAbortable?: boolean;
    events?: AgentEventPayload[];
    plan?: { steps: Array<{ step: string; status: string }>; explanation?: string };
  };
};

export type ChatHistoryDeltaResult = Omit<
  ProtocolChatHistoryDeltaResult,
  "sessionInfo" | "inFlightRun" | "metadata"
> & {
  sessionInfo?: GatewaySessionRow;
  inFlightRun?: ChatHistoryResult["inFlightRun"];
  metadata?: Partial<ChatMetadataResult>;
};

export type { ChatHistoryResetResult };

export type ChatHistoryResponse =
  | ChatHistoryResult
  | ChatHistoryDeltaResult
  | ChatHistoryResetResult;

export type ChatHistoryObservation = {
  owner: ChatHistorySessions;
  reconcile: ReturnType<ChatHistorySessions["captureReconcile"]>;
  run?: ChatHistoryRunObservation;
};

export type ObservedChatHistoryResult = ChatHistoryResult & {
  observation: ChatHistoryObservation;
};

export type ObservedChatHistoryResponse = ChatHistoryResponse & {
  observation: ChatHistoryObservation;
};

export function isHistoryCursor(
  result: ChatHistoryResponse,
): result is ChatHistoryDeltaResult | ChatHistoryResetResult {
  return "kind" in result;
}

export function resolveChatHistoryPagination(
  result: ChatHistoryResult | undefined,
  totalMessages?: number,
): ChatHistoryPagination {
  const validTotal = asSafeIntegerInRange(result?.totalMessages ?? totalMessages, { min: 0 });
  const nextOffset = asSafeIntegerInRange(result?.nextOffset, { min: 1 });
  const olderCursor = normalizeNullableString(result?.olderCursor);
  const newerCursor = normalizeNullableString(result?.newerCursor);
  const newer = newerCursor ? { newerCursor, hasNewer: true as const } : {};
  if (result?.hasMore === true || olderCursor) {
    return {
      hasMore: true,
      ...newer,
      ...(olderCursor ? { olderCursor } : {}),
      ...(nextOffset !== undefined ? { nextOffset } : {}),
      ...(validTotal !== undefined ? { totalMessages: validTotal } : {}),
    };
  }
  return {
    hasMore: false,
    ...newer,
    ...(validTotal !== undefined ? { totalMessages: validTotal } : {}),
    ...(result?.completeSnapshot === true ? { completeSnapshot: true as const } : {}),
  };
}

export function historySessionId(result: ChatHistoryResult): string | null {
  return (
    normalizeNullableString(result.sessionInfo?.sessionId) ??
    normalizeNullableString(result.sessionId)
  );
}

function retainedRawHistoryStart(pagination: ChatHistoryPagination): number | null {
  const totalMessages = asSafeIntegerInRange(pagination.totalMessages, { min: 0 });
  if (totalMessages === undefined) {
    return null;
  }
  const retainedDepth = pagination.hasMore ? pagination.nextOffset : totalMessages;
  if (retainedDepth === undefined) {
    return null;
  }
  const start = totalMessages - retainedDepth + 1;
  return asSafeIntegerInRange(start, { min: 1 }) ?? null;
}

export function reconcileHistoryTail(options: {
  nextMessages: unknown[];
  nextPagination: ChatHistoryPagination;
  nextSessionId: string | null;
  previousMessages: unknown[];
  previousPagination: ChatHistoryPagination;
  previousSessionId: string | null;
}): { messages: unknown[]; pagination: ChatHistoryPagination; retainedCoverage?: true } | null {
  if (!options.previousSessionId || options.previousSessionId !== options.nextSessionId) {
    return null;
  }
  if (options.previousPagination.hasNewer) {
    // A background tail refresh is not contiguous with a detached reader.
    // Latest explicitly resets this window; never stitch across the newer gap.
    return { messages: options.previousMessages, pagination: options.previousPagination };
  }
  const previousByIdentity = new Map<string, unknown[]>();
  for (const message of options.previousMessages) {
    const identity = nativeHistoryMessageIdentity(message);
    if (identity) {
      const matches = previousByIdentity.get(identity) ?? [];
      matches.push(message);
      previousByIdentity.set(identity, matches);
    }
  }
  // Identical history rows keep their render identity, including projected siblings.
  const messages = options.nextMessages.map((message) => {
    const identity = nativeHistoryMessageIdentity(message);
    return (identity ? previousByIdentity.get(identity)?.shift() : undefined) ?? message;
  });
  const reconciled = { messages, pagination: options.nextPagination };
  if (!options.nextPagination.hasMore) {
    return reconciled;
  }
  const previousTotal = options.previousPagination.totalMessages;
  const nextTotal = options.nextPagination.totalMessages;
  if (previousTotal !== undefined && nextTotal !== undefined && nextTotal < previousTotal) {
    return reconciled;
  }
  const nextStart = retainedRawHistoryStart(options.nextPagination);
  const firstSource = nativeHistoryMessageSourceIdentity(messages[0]);
  const overlap = firstSource
    ? options.previousMessages.findIndex(
        (message) => nativeHistoryMessageSourceIdentity(message) === firstSource,
      )
    : options.previousMessages.indexOf(messages[0]);
  // Matching source IDs prove overlap without interpreting native sequences as
  // CLI ordinals. An empty visible window needs authoritative raw coverage;
  // a hidden page still advances the admitted oldest edge.
  const adjoining =
    typeof previousTotal === "number" &&
    nextStart !== null &&
    (options.previousMessages.length === 0
      ? nextStart <= previousTotal + 1
      : nextStart === previousTotal + 1);
  if (overlap < 0 && !adjoining) {
    return reconciled;
  }
  const prefix =
    overlap >= 0 ? options.previousMessages.slice(0, overlap) : options.previousMessages;
  const unavailable =
    options.previousPagination.hasMore &&
    !options.previousPagination.olderCursor &&
    !options.previousPagination.needsBoundary;
  // A missing edge never certified traversal. A fresh edge covers this tail
  // only; any older held prefix must reopen its own source boundary.
  if (unavailable && prefix.length === 0) {
    return reconciled;
  }
  const previousStart = retainedRawHistoryStart(options.previousPagination);
  const nextOffset =
    previousStart !== null && typeof nextTotal === "number"
      ? nextTotal - previousStart + 1
      : undefined;
  return {
    messages: [...prefix, ...messages],
    retainedCoverage: true,
    pagination: {
      ...options.previousPagination,
      ...(unavailable ? { needsBoundary: true as const } : {}),
      ...(nextTotal !== undefined ? { totalMessages: nextTotal } : {}),
      ...(options.previousPagination.hasMore && nextOffset !== undefined ? { nextOffset } : {}),
    },
  };
}

export function reopenChatHistoryBoundary(
  state: ChatState,
  boundary: string,
  pagination: ChatHistoryPagination,
  direction: "older" | "newer" = "older",
): void {
  const held = chatHistoryWindowBoundary(
    state.chatMessages,
    state.chatHistoryPagination,
    direction,
  );
  if (nativeHistoryMessageSourceIdentity(held) !== boundary) {
    throw new Error(t("chat.thread.earlierInterrupted"));
  }
  const previous = state.chatHistoryPagination;
  const segments = previous.segments?.map((segment, index, all) =>
    direction === "older" && index === 0
      ? {
          ...segment,
          hasOlder: pagination.hasMore,
          olderCursor: pagination.hasMore ? pagination.olderCursor : undefined,
        }
      : direction === "newer" && index === all.length - 1
        ? {
            ...segment,
            hasNewer: Boolean(pagination.hasNewer),
            newerCursor: pagination.newerCursor,
          }
        : segment,
  );
  state.chatHistoryPagination =
    direction === "older"
      ? {
          ...pagination,
          segments,
          newerCursor: previous.newerCursor,
          hasNewer: previous.hasNewer,
          needsNewerBoundary: previous.needsNewerBoundary,
        }
      : {
          ...previous,
          segments,
          newerCursor: pagination.newerCursor,
          hasNewer: pagination.hasNewer,
          needsNewerBoundary: undefined,
        };
  commitCurrentChatHistorySnapshot(state);
}

/** Accept producer receipts before applying the resident display budget. */
export function admitChatHistoryPage(
  state: ChatState,
  result: ChatHistoryResult,
  direction: "older" | "newer" | "around",
): "messages" | "coverage" | false {
  const messages = result.messages ?? [];
  const projection = getChatSessionProjection(state);
  const pendingRunIds = projection.entries.flatMap((entry) =>
    entry.pending && entry.identity?.role === "user" && entry.pendingRunId
      ? [entry.pendingRunId]
      : [],
  );
  if (pendingRunIds.length) {
    const adopted = reduceSessionProjection(projection, {
      type: "snapshotLoaded",
      scope: projection.scope,
      messages: messages.filter((message) => {
        const identity = readSessionMessageIdentity(message);
        return (
          identity?.role === "user" &&
          !identity.isImported &&
          (identity.id !== null || identity.sequence !== null)
        );
      }),
    });
    const remaining = new Set(
      adopted.entries.filter((entry) => entry.pending).map((entry) => entry.pendingRunId),
    );
    retireChatSubmissionDisplay(
      state,
      new Set(pendingRunIds.filter((runId) => !remaining.has(runId))),
    );
  }
  const previous = state.chatMessages;
  const previousPagination = state.chatHistoryPagination;
  const next =
    direction === "around"
      ? messages
      : direction === "older"
        ? prependUniqueNativeMessages(messages, previous)
        : prependUniqueNativeMessages(previous, messages);
  const pagination = resolveChatHistoryPagination(
    result,
    state.chatHistoryPagination.totalMessages,
  );
  const movement = direction === "around" ? "tail" : direction;
  const coverage = extendChatHistoryWindow(
    state.chatHistoryPagination,
    previous,
    messages,
    pagination,
    result.newerCursor,
    movement,
  );
  state.chatHistoryPagination = selectChatHistoryResidency(
    next,
    coverage,
    movement,
    state.readTranscriptAnchorSource?.(),
  ).pagination;
  if (direction === "around") {
    publishChatSessionProjection(
      state,
      reduceSessionProjection(projection, { type: "residencyChanged", messages: next }),
    );
  } else {
    publishChatSessionProjectionMessages(state, next);
  }
  commitCurrentChatHistorySnapshot(state);
  if (state.chatMessages.some((message) => !previous.includes(message))) {
    return "messages";
  }
  const admitted = state.chatHistoryPagination;
  // Rejected pages cannot advance navigation. Hidden pages can still certify
  // a new edge, even when no displayed body enters the resident window.
  return admitted.hasMore !== previousPagination.hasMore ||
    (admitted.hasMore &&
      previousPagination.hasMore &&
      (admitted.olderCursor !== previousPagination.olderCursor ||
        admitted.needsBoundary !== previousPagination.needsBoundary)) ||
    admitted.hasNewer !== previousPagination.hasNewer ||
    admitted.newerCursor !== previousPagination.newerCursor ||
    admitted.needsNewerBoundary !== previousPagination.needsNewerBoundary
    ? "coverage"
    : false;
}

export function commitCurrentChatHistorySnapshot(
  state: ChatState,
  deltaCursor?: string | null,
  sessionInfo?: GatewaySessionRow,
  historyState?: ChatHistoryState | null,
): void {
  if (deltaCursor !== undefined) {
    setChatHistoryCursor(state, deltaCursor ?? undefined);
  }
  const cachedDeltaCursor = readChatHistoryCursor(state);
  if (!state.chatMessagesBySession) {
    return;
  }
  const sessionKey = state.sessionKey;
  const agentId = isUiSelectedGlobalSessionKey(state, sessionKey)
    ? resolveUiSelectedSessionAgentId(state)
    : undefined;
  const previous = readChatSessionSnapshot(state.chatMessagesBySession, state, {
    sessionKey,
    agentId,
  });
  const retained = previous?.sessionId === (state.currentSessionId ?? null) ? previous : undefined;
  cacheChatSessionSnapshot(
    state.chatMessagesBySession,
    state,
    { sessionKey, agentId },
    {
      ...(cachedDeltaCursor !== undefined ? { deltaCursor: cachedDeltaCursor } : {}),
      ...(state.chatDisplayedLeafEntryId !== undefined
        ? { displayedLeafEntryId: state.chatDisplayedLeafEntryId }
        : {}),
      transcriptMetadata: sessionInfo
        ? projectChatTranscriptMetadata(sessionInfo)
        : retained?.transcriptMetadata,
      sessionState: sessionInfo
        ? projectChatSessionStateSnapshot(state, sessionInfo, retained?.sessionState)
        : retained?.sessionState,
      progressCard: retained?.progressCard,
      historyState:
        historyState === undefined ? retained?.historyState : (historyState ?? undefined),
      messages: state.chatMessages,
      pagination: state.chatHistoryPagination,
      sessionId: state.currentSessionId ?? null,
    },
  );
}

export function clearHistoryCursor(state: ChatState, sessionKey: string, agentId?: string): void {
  delete state.chatHistoryCursor;
  if (!state.chatMessagesBySession) {
    return;
  }
  const snapshot = readChatSessionSnapshot(state.chatMessagesBySession, state, {
    sessionKey,
    agentId,
  });
  if (snapshot?.deltaCursor === undefined && snapshot?.historyState === undefined) {
    return;
  }
  const { deltaCursor: _deltaCursor, historyState: _historyState, ...withoutCursor } = snapshot;
  cacheChatSessionSnapshot(
    state.chatMessagesBySession,
    state,
    { sessionKey, agentId },
    withoutCursor,
  );
}
