export type ChatHistorySegment = {
  sources: readonly string[];
  olderCursor?: string;
  newerCursor?: string;
  hasOlder: boolean;
  hasNewer: boolean;
};

type ResidentHistoryCoverage = {
  newerCursor?: string;
  hasNewer?: true;
  needsNewerBoundary?: true;
  segments?: readonly ChatHistorySegment[];
};

export type ChatHistoryPagination = ResidentHistoryCoverage &
  (
    | { hasMore: false; totalMessages?: number; completeSnapshot?: true }
    | {
        hasMore: true;
        olderCursor?: string;
        // Cache trimming removes the page edge. Reopen the held source boundary,
        // rather than using a fresh tail's cursor and skipping discarded rows.
        needsBoundary?: true;
        nextOffset?: number;
        totalMessages?: number;
      }
  );

/** A delta cursor is usable only with the transcript already adopted by this pane. */
export type ChatHistoryCursor = {
  cursor: string;
  snapshotKey: string;
  sessionId: string | null;
};

export function trimmedChatHistoryPagination(
  pagination: ChatHistoryPagination,
): ChatHistoryPagination {
  return {
    hasMore: true,
    needsBoundary: true,
    ...(pagination.hasNewer ? { hasNewer: true as const, needsNewerBoundary: true as const } : {}),
    ...(pagination.totalMessages !== undefined ? { totalMessages: pagination.totalMessages } : {}),
  };
}
