import { visibleChatHistoryMessages } from "../../lib/chat/message-visibility.ts";
import type { ChatHistoryPagination } from "./chat-history-pagination.ts";
import { CHAT_HISTORY_REQUEST_LIMIT } from "./chat-history-request-params.ts";
import { requestOlderChatHistoryPage } from "./chat-history-request.ts";
import {
  type ChatHistoryResult,
  historySessionId,
  prepareChatHistoryPages,
  resolveChatHistoryPagination,
} from "./chat-history-snapshot.ts";
import { MAX_RESIDENT_SEGMENTS, prepareChatHistoryPacket } from "./chat-history-window.ts";
import type { ChatState } from "./chat-state-contract.ts";
import { readChatLocalOutputs } from "./history-merge.ts";

/** A Stop reset may cut a transcript held from its start. Only fresh server
 * packets can refill it; larger gaps keep their lazy, authoritative boundary. */
function heldHistoryGapCursor(options: {
  result: ChatHistoryResult;
  previousMessages: unknown[];
  previousPagination: ChatHistoryPagination;
  previousSessionId: string | null;
}): string | null {
  const next = resolveChatHistoryPagination(options.result);
  if (
    !next.hasMore ||
    !next.olderCursor ||
    next.nextOffset === undefined ||
    next.totalMessages === undefined ||
    options.result.windowReset === true ||
    options.previousPagination.hasMore ||
    options.previousPagination.hasNewer ||
    options.previousMessages.length === 0 ||
    !options.previousSessionId ||
    options.previousSessionId !== historySessionId(options.result)
  ) {
    return null;
  }
  const rowsBeforeTail = next.totalMessages - next.nextOffset;
  return rowsBeforeTail <= CHAT_HISTORY_REQUEST_LIMIT * MAX_RESIDENT_SEGMENTS
    ? next.olderCursor
    : null;
}

/** Reuse hydration's request claim and the resident admission budget. Coverage
 * stays separate: concatenated rows must never earn one wire-packet certificate. */
export async function fillHeldHistoryGap<Tail extends ChatHistoryResult>(
  state: ChatState,
  client: NonNullable<ChatState["client"]>,
  sessionKey: string,
  requestAgentId: string | undefined,
  tail: Tail,
  isCurrent: () => boolean,
  signal: AbortSignal,
): Promise<{ result: Tail; pagination?: ChatHistoryPagination }> {
  let cursor = heldHistoryGapCursor({
    result: tail,
    previousMessages: state.chatMessages,
    previousPagination: state.chatHistoryPagination,
    previousSessionId: state.currentSessionId ?? null,
  });
  if (!cursor) {
    return { result: tail };
  }
  const messages = visibleChatHistoryMessages(tail.messages ?? []);
  const pagination = resolveChatHistoryPagination(tail);
  let prepared = prepareChatHistoryPages(
    { chatMessages: [], chatHistoryPagination: { hasMore: false } },
    [
      {
        ...tail,
        messages,
        packet: prepareChatHistoryPacket(messages, pagination, tail.newerCursor),
      },
    ],
    "around",
    readChatLocalOutputs(state),
  );
  let result = tail;
  if (!prepared.fits) {
    return { result };
  }
  for (let attempt = 0; cursor && attempt < MAX_RESIDENT_SEGMENTS; attempt++) {
    const older = await requestOlderChatHistoryPage(
      client,
      sessionKey,
      requestAgentId,
      { cursor },
      isCurrent,
      signal,
    ).catch(() => undefined);
    if (
      !isCurrent() ||
      signal.aborted ||
      !older ||
      older.windowReset ||
      historySessionId(older) !== historySessionId(tail)
    ) {
      break;
    }
    const next = prepareChatHistoryPages(
      {
        chatMessages: prepared.messages,
        chatHistoryPagination: prepared.pagination,
        readTranscriptAnchorSource: state.readTranscriptAnchorSource,
      },
      [older],
      "older",
      readChatLocalOutputs(state),
    );
    const retained = new Set(next.pagination.segments?.flatMap((segment) => segment.sources));
    // Refilling cannot evict its fresh tail or an already accepted gap packet.
    // A non-fitting next packet leaves the last accepted edge available lazily.
    if (
      !next.fits ||
      prepared.pagination.segments?.some((segment) =>
        segment.sources.some((source) => !retained.has(source)),
      ) ||
      (next.pagination.hasMore && next.pagination.olderCursor === cursor)
    ) {
      break;
    }
    prepared = next;
    result = {
      ...tail,
      messages: next.messages,
      packet: undefined,
      hasMore: next.pagination.hasMore,
      olderCursor: next.pagination.hasMore ? next.pagination.olderCursor : undefined,
      nextOffset: next.pagination.hasMore ? next.pagination.nextOffset : undefined,
    };
    cursor = next.pagination.hasMore ? (next.pagination.olderCursor ?? null) : null;
  }
  return result === tail ? { result } : { result, pagination: prepared.pagination };
}
