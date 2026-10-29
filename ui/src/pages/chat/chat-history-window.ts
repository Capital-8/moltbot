import {
  reduceSessionProjection,
  type SessionProjectionState,
  type SessionProjectionEntry,
} from "@openclaw/gateway-client/browser";
import { nativeHistoryMessageSourceIdentity } from "../../lib/chat/history-message-identity.ts";
import type {
  ChatHistoryCursor,
  ChatHistoryPagination,
  ChatHistorySegment,
} from "./chat-history-pagination.ts";

// Counts admitted message entries, before renderer grouping. Source groups and
// lifecycle-owned pins are indivisible exceptions, not a whole-pane heap bound.
export const CHAT_RESIDENT_ENTRY_TARGET = 400;
export const CHAT_RESIDENT_WEIGHT_TARGET = 3 * 1024 * 1024;
const MAX_RESIDENT_SEGMENTS = 8;
const messageWeights = new WeakMap<object, number>();

function admitResidentLiveSources(
  pagination: ChatHistoryPagination,
  entries: readonly SessionProjectionEntry[],
): ChatHistoryPagination {
  if (!pagination.segments?.length) {
    return pagination;
  }
  const segments = [...pagination.segments];
  const owners = new Map(
    segments.flatMap((segment, index) => segment.sources.map((source) => [source, index] as const)),
  );
  const sourceEntries = entries.map((entry) => ({
    entry,
    source: nativeHistoryMessageSourceIdentity(entry.message),
  }));
  const firstHeld = sourceEntries.findIndex(({ source }) => source !== null && owners.has(source));
  const lastHeld = sourceEntries.findLastIndex(
    ({ source }) => source !== null && owners.has(source),
  );
  let previousSource: string | null = null;
  let changed = false;
  for (const [index, { entry, source }] of sourceEntries.entries()) {
    if (source && owners.has(source)) {
      previousSource = source;
      continue;
    }
    // Live receipts can precede a stale tail. Admit only inside its certified
    // coverage; an evicted prefix or detached newer gap still needs a server page.
    if (
      !entry.live ||
      !source ||
      (segments[0]!.hasOlder && firstHeld >= 0 && index < firstHeld) ||
      (pagination.hasNewer && (lastHeld < 0 || index > lastHeld))
    ) {
      continue;
    }
    const owner = previousSource === null ? 0 : owners.get(previousSource)!;
    const segment = segments[owner]!;
    const sources = [...segment.sources];
    const insertion = previousSource === null ? 0 : sources.indexOf(previousSource) + 1;
    sources.splice(insertion, 0, source);
    segments[owner] = {
      ...segment,
      sources,
      ...(segment.hasNewer && insertion === segment.sources.length
        ? { newerCursor: undefined }
        : {}),
    };
    owners.set(source, owner);
    previousSource = source;
    changed = true;
  }
  if (!changed) {
    return pagination;
  }
  const groups = new Map<string, { count: number; weight: number }>();
  for (const { entry, source } of sourceEntries) {
    if (source) {
      const group = groups.get(source);
      groups.set(source, {
        count: (group?.count ?? 0) + 1,
        weight: (group?.weight ?? 0) + messageWeight(entry.message),
      });
    }
  }
  return {
    ...pagination,
    segments: segments.flatMap((segment, index) => {
      if (segment === pagination.segments![index]) {
        return [segment];
      }
      const chunks: string[][] = [[]];
      let count = 0;
      let weight = 1;
      for (const source of segment.sources) {
        const group = groups.get(source);
        if (
          chunks.at(-1)!.length &&
          (count + (group?.count ?? 0) > 80 || weight + (group?.weight ?? 0) > 256 * 1024)
        ) {
          chunks.push([]);
          count = 0;
          weight = 1;
        }
        chunks.at(-1)!.push(source);
        count += group?.count ?? 0;
        weight += group?.weight ?? 0;
      }
      return chunks.map((sources, chunk) => {
        const page: ChatHistorySegment = {
          sources,
          hasOlder: chunk === 0 ? segment.hasOlder : true,
          hasNewer: chunk === chunks.length - 1 ? segment.hasNewer : true,
        };
        if (chunk === 0 && segment.olderCursor) {
          page.olderCursor = segment.olderCursor;
        }
        if (chunk === chunks.length - 1 && segment.newerCursor) {
          page.newerCursor = segment.newerCursor;
        }
        return page;
      });
    }),
  };
}

function messageWeight(message: unknown): number {
  if (message && typeof message === "object") {
    const cached = messageWeights.get(message);
    if (cached !== undefined) {
      return cached;
    }
    const weight = JSON.stringify([message]).length - 1;
    messageWeights.set(message, weight);
    return weight;
  }
  return JSON.stringify([message]).length - 1;
}

export function prepareChatHistorySegment(
  messages: readonly unknown[],
  pagination: ChatHistoryPagination,
  newerCursor?: string,
): ChatHistorySegment {
  return {
    sources: [
      ...new Set(
        messages.flatMap((message) => {
          const source = nativeHistoryMessageSourceIdentity(message);
          // Prepare immutable body weights at admission, not on every stream delta.
          messageWeight(message);
          return source ? [source] : [];
        }),
      ),
    ],
    ...(pagination.hasMore && pagination.olderCursor
      ? { olderCursor: pagination.olderCursor }
      : {}),
    ...(newerCursor ? { newerCursor } : {}),
    hasOlder: pagination.hasMore,
    hasNewer: Boolean(pagination.hasNewer || newerCursor),
  };
}

/** Each opaque edge certifies its own complete server response segment. */
export function extendChatHistoryWindow(
  previous: ChatHistoryPagination,
  previousMessages: readonly unknown[],
  incoming: readonly unknown[],
  pagination: ChatHistoryPagination,
  newerCursor: string | undefined,
  direction: "older" | "newer" | "tail",
  retainedCoverage?: ChatHistoryPagination,
): ChatHistoryPagination {
  const page = prepareChatHistorySegment(incoming, pagination, newerCursor);
  const held = previous.segments ?? [
    prepareChatHistorySegment(previousMessages, previous, previous.newerCursor),
  ];
  const known = new Set(held.flatMap((segment) => segment.sources));
  let segments: ChatHistorySegment[];
  if (direction !== "tail" && page.sources.every((source) => known.has(source))) {
    // Hidden/overlap-only traversal advances a raw edge, not a new body page.
    segments = [...held];
    if (direction === "older") {
      segments[0] = { ...held[0]!, hasOlder: page.hasOlder, olderCursor: page.olderCursor };
    } else {
      segments[segments.length - 1] = {
        ...held.at(-1)!,
        hasNewer: page.hasNewer,
        newerCursor: page.newerCursor,
      };
    }
  } else if (direction === "tail" && retainedCoverage) {
    const incomingSources = new Set(page.sources);
    const prefix = held
      .filter((segment) => segment.sources.some((source) => !incomingSources.has(source)))
      .map((segment) =>
        segment.hasNewer
          ? segment
          : Object.assign({}, segment, { hasNewer: true, newerCursor: undefined }),
      );
    // A refresh must not rewind a hidden-page edge just because its visible
    // prefix is empty. The reconciliation owner already proved continuity.
    segments = prefix.length
      ? [...prefix, page]
      : [
          {
            ...page,
            hasOlder: previous.hasMore,
            olderCursor: previous.hasMore ? previous.olderCursor : undefined,
          },
        ];
  } else {
    let retained = held;
    if (direction !== "tail" && page.sources.some((source) => known.has(source))) {
      const positions = new Map(page.sources.map((source, index) => [source, index] as const));
      const boundary =
        direction === "older"
          ? page.sources.findLastIndex((source) => !known.has(source))
          : page.sources.findIndex((source) => !known.has(source));
      // A live receipt can precede a hidden raw tail's anchor. Once this page
      // extends past it, retire its old alias so page eviction cannot leave an
      // isolated body. Ordinary boundary overlap still belongs to both pages.
      retained = held.map((segment) => {
        const sources = segment.sources.filter((source) => {
          const index = positions.get(source);
          return (
            index === undefined || (direction === "older" ? index >= boundary : index <= boundary)
          );
        });
        return sources.length === segment.sources.length
          ? segment
          : Object.assign({}, segment, { sources });
      });
    }
    segments =
      direction === "tail"
        ? [page]
        : direction === "older"
          ? [page, ...retained]
          : [...retained, page];
  }
  return {
    ...(retainedCoverage ?? pagination),
    segments,
    ...(direction === "older" && previous.hasNewer
      ? {
          hasNewer: true as const,
          newerCursor: previous.newerCursor,
          needsNewerBoundary: previous.needsNewerBoundary,
        }
      : direction === "newer" && newerCursor
        ? { hasNewer: true as const, newerCursor }
        : {}),
  };
}

/** Bound the reloadable portion, then let the reducer preserve exact live pins. */
export function selectChatHistoryResidency(
  messages: readonly unknown[],
  pagination: ChatHistoryPagination,
  direction: "older" | "newer" | "tail" = "tail",
  readerSource?: string | null,
): { messages: readonly unknown[]; pagination: ChatHistoryPagination } {
  if (!pagination.segments?.length) {
    return { messages, pagination };
  }
  const segments = [...pagination.segments];
  const protectsReader = (segment: ChatHistorySegment) =>
    readerSource != null && segment.sources.includes(readerSource);
  const groups = new Map<string, { count: number; weight: number }>();
  for (const message of messages) {
    const source = nativeHistoryMessageSourceIdentity(message);
    if (!source) {
      continue;
    }
    const previous = groups.get(source);
    groups.set(source, {
      count: (previous?.count ?? 0) + 1,
      weight: (previous?.weight ?? 0) + messageWeight(message),
    });
  }
  const sources = () => new Set(segments.flatMap((segment) => segment.sources));
  const withinBudget = () => {
    let count = 0;
    let weight = 1;
    for (const source of sources()) {
      const group = groups.get(source);
      count += group?.count ?? 0;
      weight += group?.weight ?? 0;
    }
    return (
      segments.length <= MAX_RESIDENT_SEGMENTS &&
      count <= CHAT_RESIDENT_ENTRY_TARGET &&
      weight <= CHAT_RESIDENT_WEIGHT_TARGET
    );
  };
  let trimmed = false;
  while (segments.length > 1 && !withinBudget()) {
    const fromRight =
      direction === "older" ? !protectsReader(segments.at(-1)!) : protectsReader(segments[0]!);
    if (fromRight) {
      segments.pop();
      const last = segments.at(-1)!;
      segments[segments.length - 1] = { ...last, hasNewer: true };
    } else {
      segments.shift();
      segments[0] = { ...segments[0]!, hasOlder: true };
    }
    trimmed = true;
  }
  // Old warm records can contain a larger unsegmented page. Reopen an actual
  // retained source boundary after group trimming; never reuse an interior edge.
  while (
    segments.length === 1 &&
    !protectsReader(segments[0]!) &&
    segments[0]!.sources.length > 1 &&
    !withinBudget()
  ) {
    const segment = segments[0]!;
    segments[0] =
      direction === "older"
        ? {
            ...segment,
            sources: segment.sources.slice(0, -1),
            hasNewer: true,
            newerCursor: undefined,
          }
        : { ...segment, sources: segment.sources.slice(1), hasOlder: true, olderCursor: undefined };
    trimmed = true;
  }
  const first = segments[0]!;
  const last = segments[segments.length - 1]!;
  const retained = sources();
  const admitted = messages.filter((message) => {
    const source = nativeHistoryMessageSourceIdentity(message);
    return source !== null && retained.has(source);
  });
  const nextPagination: ChatHistoryPagination = {
    ...(first.hasOlder
      ? {
          hasMore: true as const,
          ...(first.olderCursor
            ? { olderCursor: first.olderCursor }
            : { needsBoundary: true as const }),
        }
      : { hasMore: false as const }),
    ...(pagination.totalMessages !== undefined ? { totalMessages: pagination.totalMessages } : {}),
    ...(!trimmed &&
    !first.hasOlder &&
    !last.hasNewer &&
    !pagination.hasMore &&
    pagination.completeSnapshot
      ? { completeSnapshot: true as const }
      : {}),
    ...(!trimmed && pagination.hasMore && pagination.nextOffset !== undefined
      ? { nextOffset: pagination.nextOffset }
      : {}),
    ...(last.hasNewer
      ? {
          hasNewer: true as const,
          ...(last.newerCursor
            ? { newerCursor: last.newerCursor }
            : { needsNewerBoundary: true as const }),
        }
      : {}),
    segments,
  };
  return {
    messages: admitted,
    pagination: nextPagination,
  };
}

/** Live/reader pins are not reloadable coverage and cannot lend a page edge. */
export function chatHistoryWindowBoundary(
  messages: readonly unknown[],
  pagination: ChatHistoryPagination,
  direction: "older" | "newer",
): unknown {
  const segment = direction === "older" ? pagination.segments?.[0] : pagination.segments?.at(-1);
  const source = direction === "older" ? segment?.sources[0] : segment?.sources.at(-1);
  return source
    ? messages.find((message) => nativeHistoryMessageSourceIdentity(message) === source)
    : direction === "older"
      ? messages[0]
      : messages.at(-1);
}

/** Publication shares the page admission policy while retaining live/run pins. */
export function projectResidentChatHistory(
  projection: SessionProjectionState,
  pagination: ChatHistoryPagination,
  readerSource: string | null | undefined,
  pinnedRunId?: string | null,
) {
  const coverage = admitResidentLiveSources(pagination, projection.entries);
  const admitted = selectChatHistoryResidency(projection.messages, coverage, "tail", readerSource);
  return {
    projection: reduceSessionProjection(projection, {
      type: "residencyChanged",
      messages: admitted.messages,
      pinnedRunIds: pinnedRunId ? [pinnedRunId] : [],
    }),
    pagination: admitted.pagination,
  };
}

/** Retire secondary sources in the same synchronous publication as the visible array. */
export function publishResidentChatMessages(
  owner: {
    chatMessages: unknown[];
    transcriptMessagesRetired?: (messages: readonly unknown[]) => void;
  },
  previous: SessionProjectionState | undefined,
  projection: SessionProjectionState,
): void {
  if (
    owner.chatMessages.length !== projection.messages.length ||
    owner.chatMessages.some((message, index) => message !== projection.messages[index])
  ) {
    owner.chatMessages = [...projection.messages];
    // Dormant search, reply and attachment projections may still own old rows.
    // Retire their sources synchronously, even while their pane is hidden.
    const retained = new Set(projection.messages);
    const retired = previous?.messages.filter((message) => !retained.has(message));
    if (retired?.length) {
      owner.transcriptMessagesRetired?.(retired);
    }
  }
}

export type ChatHistoryResidencyOwner = {
  chatHistoryCursor?: ChatHistoryCursor;
  chatHistoryPagination?: ChatHistoryPagination;
  lastLocalTerminalReconcile?: { runId: string | null } | null;
  transcriptMessagesRetired?: (messages: readonly unknown[]) => void;
  readTranscriptAnchorSource?: () => string | null;
};
