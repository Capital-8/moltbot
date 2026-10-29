import { createSessionProjection, reduceSessionProjection } from "@openclaw/gateway-client/browser";
import { expect, it } from "vitest";
import { nativeHistoryMessageSourceIdentity } from "../../lib/chat/history-message-identity.ts";
import {
  extendChatHistoryWindow,
  prepareChatHistorySegment,
  projectResidentChatHistory,
  selectChatHistoryResidency,
} from "./chat-history-window.ts";

it("keeps an indivisible source group above the entry target", () => {
  const messages = Array.from({ length: 401 }, (_, index) => ({
    role: "assistant",
    content: `fragment-${index}`,
    __openclaw: { id: "source", seq: 1 },
  }));
  const pagination = { hasMore: false as const };
  const admitted = selectChatHistoryResidency(messages, {
    ...pagination,
    segments: [prepareChatHistorySegment(messages, pagination)],
  });
  expect(admitted.messages).toEqual(messages);
  expect(admitted.pagination.hasMore).toBe(false);
  expect(admitted.pagination.hasNewer).toBeUndefined();
});

it("keeps a protected reader segment intact above the weight target until the reader moves", () => {
  const messages = [1, 2].map((seq) => ({
    role: "assistant",
    content: "x".repeat(2 * 1024 * 1024),
    __openclaw: { id: `source-${seq}`, seq },
  }));
  const pagination = { hasMore: false as const };
  const segment = prepareChatHistorySegment(messages, pagination);
  const held = selectChatHistoryResidency(
    messages,
    { ...pagination, segments: [segment] },
    "tail",
    nativeHistoryMessageSourceIdentity(messages[0]),
  );
  expect(held.messages).toEqual(messages);
  const released = selectChatHistoryResidency(messages, held.pagination);
  expect(released.messages).toEqual([messages[1]]);
  expect(released.pagination).toMatchObject({ hasMore: true, needsBoundary: true });
});

const durable = (seq: number) => ({
  role: "user",
  content: `source-${seq}`,
  __openclaw: { id: `source-${seq}`, seq },
});

it.each([
  { older: false, newer: false, expected: [1, 2, 3, 4, 5] },
  { older: true, newer: false, expected: [2, 3, 4, 5] },
  { older: false, newer: true, expected: [1, 2, 3, 4] },
  { older: true, newer: true, expected: [2, 3, 4] },
])(
  "admits live receipts inside certified coverage (older=$older newer=$newer)",
  ({ older, newer, expected }) => {
    const messages = [1, 2, 3, 4, 5].map(durable);
    const held = [messages[1], messages[3]];
    let projection = createSessionProjection({}, held);
    for (const message of [messages[0], messages[2], messages[4]]) {
      projection = reduceSessionProjection(projection, { type: "messagePersisted", message });
    }
    const pagination = older
      ? { hasMore: true as const, olderCursor: "older" }
      : { hasMore: false as const };
    const segment = prepareChatHistorySegment(held, pagination, newer ? "newer" : undefined);
    const admitted = projectResidentChatHistory(
      projection,
      {
        ...pagination,
        ...(newer ? { hasNewer: true as const, newerCursor: "newer" } : {}),
        segments: [segment],
      },
      null,
    );
    expect(admitted.projection.messages).toEqual(expected.map((seq) => messages[seq - 1]));
    expect(admitted.pagination.segments?.flatMap((page) => page.sources)).toEqual(
      expected.map((seq) => `id:source-${seq}`),
    );
    expect(admitted.pagination.hasMore).toBe(older);
    expect(admitted.pagination.hasNewer).toBe(newer || undefined);
  },
);

it("keeps a long stale-snapshot receipt prefix bounded instead of pinning every live row", () => {
  const messages = Array.from({ length: 560 }, (_, index) => durable(index + 1));
  let projection = createSessionProjection({}, messages.slice(-1));
  for (const message of messages.slice(0, -1)) {
    projection = reduceSessionProjection(projection, { type: "messagePersisted", message });
  }
  const pagination = { hasMore: false as const };
  const admitted = projectResidentChatHistory(
    projection,
    {
      ...pagination,
      segments: [prepareChatHistorySegment(messages.slice(-1), pagination)],
    },
    null,
  );
  expect(admitted.projection.messages).toEqual(messages.slice(-400));
  expect(admitted.projection.messages.at(-1)).toBe(messages.at(-1));
  expect(admitted.pagination.hasMore).toBe(true);
});

it.each([false, true])(
  "admits live receipts after an empty visible tail unless detached (newer=%s)",
  (newer) => {
    const message = durable(1);
    const projection = reduceSessionProjection(createSessionProjection(), {
      type: "messagePersisted",
      message,
    });
    const pagination = { hasMore: true as const, olderCursor: "hidden-older" };
    const admitted = projectResidentChatHistory(
      projection,
      {
        ...pagination,
        ...(newer ? { hasNewer: true as const } : {}),
        segments: [prepareChatHistorySegment([], pagination, newer ? "hidden-newer" : undefined)],
      },
      null,
    );
    expect(admitted.projection.messages).toEqual(newer ? [] : [message]);
    expect(admitted.pagination.hasMore).toBe(true);
  },
);

it("repartitions live source groups once without splitting fragments or changing repeated publication", () => {
  const messages = Array.from({ length: 50 }, (_, index) =>
    ["a", "b"].map((part) => ({
      role: "assistant",
      content: index === 19 ? "x".repeat(140 * 1024) : `${index + 1}-${part}`,
      __openclaw: { id: `source-${index + 1}`, seq: index + 1 },
      openclawStreamFallback: { itemId: `fragment-${index + 1}-${part}` },
    })),
  );
  const held = messages.at(-1)!;
  let projection = createSessionProjection({}, held);
  for (const group of messages.slice(0, -1)) {
    for (const message of group) {
      projection = reduceSessionProjection(projection, { type: "messagePersisted", message });
    }
  }
  const pagination = { hasMore: false as const };
  const admitted = projectResidentChatHistory(
    projection,
    { ...pagination, segments: [prepareChatHistorySegment(held, pagination)] },
    null,
  );
  expect(admitted.projection.messages).toEqual(messages.flat());
  expect(admitted.pagination.segments?.map((segment) => segment.sources.length)).toEqual([
    19, 1, 30,
  ]);
  expect(admitted.pagination.segments?.[1]?.sources).toEqual(["id:source-20"]);
  const repeated = projectResidentChatHistory(admitted.projection, admitted.pagination, null);
  expect(repeated.projection).toBe(admitted.projection);
  expect(repeated.pagination).toEqual(admitted.pagination);
  expect(repeated.pagination.segments).toEqual(admitted.pagination.segments);
});

it("retires an interior live alias with its authoritative page instead of leaving an isolated source", () => {
  const messages = [1, 2, 3].map(durable);
  const pagination = { hasMore: true as const, olderCursor: "raw-hidden-older" };
  const live = reduceSessionProjection(createSessionProjection(), {
    type: "messagePersisted",
    message: messages[1],
  });
  const initial = projectResidentChatHistory(
    live,
    { ...pagination, segments: [prepareChatHistorySegment([], pagination)] },
    null,
  );
  const coverage = extendChatHistoryWindow(
    initial.pagination,
    initial.projection.messages,
    messages,
    { hasMore: false },
    "after-source-3",
    "older",
  );
  let resident = projectResidentChatHistory(createSessionProjection({}, messages), coverage, null);
  const later = Array.from({ length: 398 }, (_, index) => durable(index + 4));
  let projection = resident.projection;
  for (const message of later) {
    projection = reduceSessionProjection(projection, { type: "messagePersisted", message });
  }
  resident = projectResidentChatHistory(projection, resident.pagination, null);
  expect(resident.projection.messages).toEqual(later.slice(77));
  expect(resident.pagination).toMatchObject({ hasMore: true });
  expect(resident.pagination.hasNewer).toBeUndefined();
  const repeated = projectResidentChatHistory(resident.projection, resident.pagination, null);
  expect(repeated.projection).toBe(resident.projection);
  expect(repeated.pagination).toEqual(resident.pagination);
});

it.each(["older", "newer"] as const)(
  "preserves ordinary overlapping segment membership while extending %s",
  (direction) => {
    const messages = [1, 2, 3].map(durable);
    const held = direction === "older" ? messages.slice(1) : messages.slice(0, 2);
    const incoming = direction === "older" ? messages.slice(0, 2) : messages.slice(1);
    const pagination = { hasMore: true as const, olderCursor: "held-older" };
    const segment = prepareChatHistorySegment(held, pagination, "held-newer");
    const extended = extendChatHistoryWindow(
      { ...pagination, hasNewer: true as const, newerCursor: "held-newer", segments: [segment] },
      held,
      incoming,
      pagination,
      "page-newer",
      direction,
    );
    expect(extended.segments?.[direction === "older" ? 1 : 0]).toBe(segment);
    expect(segment.sources).toEqual(held.map(nativeHistoryMessageSourceIdentity));
  },
);
