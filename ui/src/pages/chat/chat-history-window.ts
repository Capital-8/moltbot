import {
  reduceSessionProjection,
  type SessionProjectionState,
  type SessionProjectionEntry,
} from "@openclaw/gateway-client/browser";
import {
  nativeHistoryMessageSourceIdentity,
  nativeHistoryMessageSourceId,
} from "../../lib/chat/history-message-identity.ts";
import type {
  ChatHistoryCursor,
  ChatHistoryPagination,
  ChatHistorySegment,
} from "./chat-history-pagination.ts";
import {
  CHAT_HISTORY_REQUEST_LIMIT,
  CHAT_HISTORY_REQUEST_MAX_BYTES,
} from "./chat-history-request-params.ts";

// Counts admitted message entries, before renderer grouping. Source groups and
// lifecycle-owned pins are indivisible exceptions, not a whole-pane heap bound.
export const CHAT_RESIDENT_ENTRY_TARGET = 400;
export const CHAT_RESIDENT_WEIGHT_TARGET = 3 * 1024 * 1024;
export const MAX_RESIDENT_SEGMENTS = 8;
const messageWeights = new WeakMap<object, number>();

/** Body mutations revoke wire provenance without changing coverage or opaque edges. */
export function invalidateChatHistoryPacketSources(
  pagination: ChatHistoryPagination,
  sources: ReadonlySet<string>,
): ChatHistoryPagination {
  let changed = false;
  const segments = pagination.segments?.map((segment) => {
    if (!segment.boundedPacket || !segment.sources.some((source) => sources.has(source))) {
      return segment;
    }
    changed = true;
    return { ...segment, boundedPacket: undefined };
  });
  return changed ? { ...pagination, segments } : pagination;
}

function admitResidentLiveSources(
  initialPagination: ChatHistoryPagination,
  entries: readonly SessionProjectionEntry[],
): ChatHistoryPagination {
  if (!initialPagination.segments?.length) {
    return initialPagination;
  }
  const sourceEntries = entries.map((entry) => ({
    entry,
    source: nativeHistoryMessageSourceIdentity(entry.message),
  }));
  // A source can gain fragments or replace its body without changing its name.
  // Revoke every overlapping packet, without turning flag-only changes into repartitioning.
  const pagination = invalidateChatHistoryPacketSources(
    initialPagination,
    new Set(
      sourceEntries.flatMap(({ entry, source }) =>
        source && (entry.live || entry.pending) ? [source] : [],
      ),
    ),
  );
  const segments = [...pagination.segments!];
  const owners = new Map(
    segments.flatMap((segment, index) => segment.sources.map((source) => [source, index] as const)),
  );
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
      boundedPacket: undefined,
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
          (count + (group?.count ?? 0) > CHAT_HISTORY_REQUEST_LIMIT ||
            weight + (group?.weight ?? 0) > CHAT_HISTORY_REQUEST_MAX_BYTES)
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

function sourceGroups(messages: readonly unknown[]) {
  const groups = new Map<string, { count: number; weight: number; reopenable: boolean }>();
  for (const message of messages) {
    const source = nativeHistoryMessageSourceIdentity(message);
    if (source) {
      const previous = groups.get(source);
      groups.set(source, {
        count: (previous?.count ?? 0) + 1,
        weight: (previous?.weight ?? 0) + messageWeight(message),
        reopenable: Boolean(nativeHistoryMessageSourceId(message)),
      });
    }
  }
  return groups;
}

function intrinsicGroup(group: { count: number; weight: number } | undefined) {
  return Boolean(
    group &&
    (group.count > CHAT_RESIDENT_ENTRY_TARGET || group.weight + 1 > CHAT_RESIDENT_WEIGHT_TARGET),
  );
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

/** Prepare immutable wire facts once, before tentative batch admission reuses them. */
export function prepareChatHistoryPacket(
  messages: readonly unknown[],
  pagination: ChatHistoryPagination,
  newerCursor?: string,
): ChatHistorySegment {
  const page = prepareChatHistorySegment(messages, pagination, newerCursor);
  if (
    page.sources.length <= CHAT_HISTORY_REQUEST_LIMIT &&
    new TextEncoder().encode(JSON.stringify(messages)).byteLength <= CHAT_HISTORY_REQUEST_MAX_BYTES
  ) {
    page.boundedPacket = true;
  }
  return page;
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
  preparedPacket?: ChatHistorySegment,
): ChatHistoryPagination {
  const page = preparedPacket ?? prepareChatHistorySegment(incoming, pagination, newerCursor);
  const held = retainedCoverage?.segments ??
    previous.segments ?? [
      prepareChatHistorySegment(previousMessages, previous, previous.newerCursor),
    ];
  const known = new Set(held.flatMap((segment) => segment.sources));
  let segments: ChatHistorySegment[];
  if (direction !== "tail" && page.sources.every((source) => known.has(source))) {
    // Hidden/overlap-only traversal advances a raw edge, not a new body page.
    segments = [...held];
    if (direction === "older") {
      segments[0] = {
        ...held[0]!,
        hasOlder: page.hasOlder,
        olderCursor: page.olderCursor,
        boundedPacket: undefined,
      };
    } else {
      segments[segments.length - 1] = {
        ...held.at(-1)!,
        boundedPacket: undefined,
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
          : Object.assign({}, segment, {
              hasNewer: true,
              newerCursor: undefined,
              boundedPacket: undefined,
            }),
      );
    // A refresh must not rewind a hidden-page edge just because its visible
    // prefix is empty. The reconciliation owner already proved continuity.
    segments = prefix.length
      ? [...prefix, page]
      : [
          {
            ...page,
            boundedPacket: undefined,
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
          : Object.assign({}, segment, { sources, boundedPacket: undefined });
      });
    }
    segments =
      direction === "tail"
        ? [page]
        : direction === "older"
          ? [page, ...retained]
          : [...retained, page];
  }
  // Record this at authoritative admission, never by reselecting a different
  // oversized group during warm publication or reader movement.
  const intrinsicSource =
    [...sourceGroups(incoming)].findLast(([, group]) => intrinsicGroup(group))?.[0] ??
    (direction !== "tail" || retainedCoverage ? previous.intrinsicSource : undefined);
  return {
    ...(retainedCoverage ?? pagination),
    ...(intrinsicSource ? { intrinsicSource } : {}),
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

/** Only a real source ID can reopen an interior cut. A bounded original packet
 * keeps both opaque edges while its unkeyed reader still owns that packet. */
export function chatHistoryReaderBridge(
  messages: readonly unknown[],
  pagination: ChatHistoryPagination,
  reader: string | null | undefined,
  direction: "older" | "newer",
): readonly string[] {
  const segments = pagination.segments ?? [];
  const index = segments.findIndex((segment) => reader && segment.sources.includes(reader));
  if (index < 0 || !reader) {
    return [];
  }
  const segment = segments[index]!;
  const sourceIndex = segment.sources.indexOf(reader);
  const intact =
    segment.boundedPacket &&
    !messages.some(
      (message) =>
        nativeHistoryMessageSourceIdentity(message) === reader &&
        nativeHistoryMessageSourceId(message),
    );
  return direction === "older"
    ? [
        ...segments.slice(0, index).flatMap((page) => page.sources),
        ...segment.sources.slice(0, intact ? undefined : sourceIndex + 1),
      ]
    : [
        ...segment.sources.slice(intact ? 0 : sourceIndex),
        ...segments.slice(index + 1).flatMap((page) => page.sources),
      ];
}

/** Bound the reloadable portion, then let the reducer preserve exact live pins. */
export function selectChatHistoryResidency(
  messages: readonly unknown[],
  pagination: ChatHistoryPagination,
  direction: "older" | "newer" | "tail" = "tail",
  readerSource?: string | null,
): { messages: readonly unknown[]; pagination: ChatHistoryPagination; withinBudget: boolean } {
  if (!pagination.segments?.length) {
    return { messages, pagination, withinBudget: true };
  }
  const segments = [...pagination.segments];
  const protectsReader = (segment: ChatHistorySegment) =>
    readerSource != null && segment.sources.includes(readerSource);
  const groups = sourceGroups(messages);
  const intrinsicSource = intrinsicGroup(groups.get(pagination.intrinsicSource ?? ""))
    ? pagination.intrinsicSource
    : undefined;
  const readerPacket = segments.find(
    (segment) =>
      protectsReader(segment) && segment.boundedPacket && !groups.get(readerSource!)?.reopenable,
  );
  // Ordinary packets remain charged. Only the unavoidable over-budget packet
  // containing an unkeyed reader may retain its original opaque boundaries.
  const packetCost = readerPacket?.sources.reduce(
    (cost, source) => {
      const group = groups.get(source);
      if (source !== intrinsicSource && !(source === readerSource && intrinsicGroup(group))) {
        cost.count += group?.count ?? 0;
        cost.weight += group?.weight ?? 0;
      }
      return cost;
    },
    { count: 0, weight: 1 },
  );
  const packetException =
    packetCost &&
    (packetCost.count > CHAT_RESIDENT_ENTRY_TARGET ||
      packetCost.weight > CHAT_RESIDENT_WEIGHT_TARGET)
      ? new Set(readerPacket!.sources)
      : null;
  const sources = () => new Set(segments.flatMap((segment) => segment.sources));
  const withinBudget = () => {
    let count = 0;
    let weight = 1;
    for (const source of sources()) {
      const group = groups.get(source);
      if (
        source === intrinsicSource ||
        (source === readerSource && intrinsicGroup(group)) ||
        (segments.includes(readerPacket!) && packetException?.has(source))
      ) {
        continue;
      }
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
  const trimEnd = (fromRight: boolean) => {
    const index = fromRight ? segments.length - 1 : 0;
    const segment = segments[index]!;
    if (segments.length > 1 && !protectsReader(segment)) {
      if (fromRight) {
        segments.pop();
        segments[segments.length - 1] = { ...segments.at(-1)!, hasNewer: true };
      } else {
        segments.shift();
        segments[0] = { ...segments[0]!, hasOlder: true };
      }
      return true;
    }
    if (segment === readerPacket) {
      return false;
    }
    // Every new interior edge must be reopenable by its actual source ID.
    const cut = fromRight
      ? segment.sources.findLastIndex(
          (source, sourceIndex) =>
            sourceIndex < segment.sources.length - 1 &&
            groups.get(source)?.reopenable &&
            (!readerSource || !segment.sources.slice(sourceIndex + 1).includes(readerSource)),
        )
      : segment.sources.findIndex(
          (source, sourceIndex) =>
            sourceIndex > 0 &&
            groups.get(source)?.reopenable &&
            (!readerSource || !segment.sources.slice(0, sourceIndex).includes(readerSource)),
        );
    if (cut < 0) {
      return false;
    }
    segments[index] = fromRight
      ? {
          ...segment,
          boundedPacket: undefined,
          sources: segment.sources.slice(0, cut + 1),
          hasNewer: true,
          newerCursor: undefined,
        }
      : {
          ...segment,
          boundedPacket: undefined,
          sources: segment.sources.slice(cut),
          hasOlder: true,
          olderCursor: undefined,
        };
    return true;
  };
  while (!withinBudget()) {
    const fromRight =
      direction === "older" || (direction === "tail" && protectsReader(segments[0]!));
    if (!trimEnd(fromRight) && !trimEnd(!fromRight)) {
      break;
    }
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
    ...(intrinsicSource && retained.has(intrinsicSource) ? { intrinsicSource } : {}),
    segments,
  };
  return {
    messages: admitted,
    pagination: nextPagination,
    withinBudget: withinBudget(),
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
