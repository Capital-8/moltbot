// @vitest-environment node
import { reduceSessionProjection } from "@openclaw/gateway-client/browser";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { missingScopeErrorShape } from "../../../../packages/gateway-protocol/src/schema/error-codes.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway-connect-errors.ts";
import type { GatewaySessionRow, SessionsRewindResult } from "../../api/types.ts";
import { handleChatGatewayEvent } from "./chat-gateway.ts";
import { rewindChatHistory, switchChatHistoryBranch } from "./chat-history-actions.ts";
import { loadOlderChatHistoryPage, requestChatSessionSnapshot } from "./chat-history-request.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { beginHistoryRequest } from "./chat-history-state.ts";
import { CHAT_RESIDENT_WEIGHT_TARGET, prepareChatHistoryPacket } from "./chat-history-window.ts";
import {
  activeHistory as emptyActiveHistory,
  createState,
  type TestState,
} from "./chat-history.inflight.test-support.ts";
import { loadChatHistory, type ChatEventPayload } from "./chat-history.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import type { ChatState } from "./chat-state-contract.ts";
import { ChatAttachmentReadLifecycle } from "./components/chat-attachment-reads.ts";
import {
  getChatSessionProjection,
  publishChatSessionProjection,
  reduceChatSessionProjection,
} from "./history-merge.ts";
import { handleChatDraftChange } from "./input-history.ts";
import { reconcileChatRunFromSessionRow, reconcileChatRunLifecycle } from "./run-lifecycle.ts";
import {
  cacheChatSessionSnapshot,
  readChatMessagesFromCache,
  type ChatMessageCache,
} from "./session-message-cache.ts";

function activeHistory(runId: string) {
  const history = emptyActiveHistory(runId);
  history.inFlightRun!.text = "intentionally ignored on web";
  return history;
}
const message = (role: "assistant" | "user", text: string, metadata?: Record<string, unknown>) => ({
  role,
  content: [{ type: "text", text }],
  ...(metadata ? { __openclaw: metadata } : {}),
});
function withSessions<T extends object>(history: ChatHistoryResult, methods: T) {
  const state = createState(history);
  return Object.assign(state, {
    sessions: Object.assign(state.sessions, {
      refreshReplacement: vi.fn(async () => null),
      ...methods,
    }),
  });
}
function cached(state: TestState, messages = state.chatMessages) {
  const cache: ChatMessageCache = new Map();
  state.chatMessagesBySession = cache;
  cacheChatSessionSnapshot(
    cache,
    state,
    { sessionKey: state.sessionKey },
    {
      messages,
      pagination: { hasMore: false, completeSnapshot: true },
      sessionId: "old-session",
    },
  );
  return () => readChatMessagesFromCache(cache, state, { sessionKey: state.sessionKey });
}
function publishLive(
  state: TestState,
  live: unknown,
  scope: ReturnType<typeof getChatSessionProjection>["scope"] = { sessionKey: state.sessionKey },
) {
  const projection = reduceSessionProjection(getChatSessionProjection(state, scope), {
    type: "messagePersisted",
    message: live,
    scope,
  });
  publishChatSessionProjection(state, projection);
  state.chatMessages = [...projection.messages];
}
function rewindState(history: ChatHistoryResult, response: Promise<SessionsRewindResult>) {
  const state = withSessions(history, { rewind: vi.fn(() => response) });
  return Object.assign(state, {
    handleChatDraftChange: vi.fn((next: string, mentions?: ChatState["chatMentions"]) =>
      handleChatDraftChange(state, next, mentions),
    ),
  });
}
const rewind = (state: ReturnType<typeof rewindState>) =>
  rewindChatHistory(state, "user-entry", new ChatAttachmentReadLifecycle(() => {}));

it("preserves prepared quiet activity through older pages and prefetched snapshots", async () => {
  const result = {
    role: "toolResult",
    toolCallId: "wait",
    toolName: "sessions_yield",
    content: [{ type: "text", text: "Waiting finished" }],
    __openclaw: { id: "wait-result", seq: 3 },
  };
  const state = createState({
    messages: [result],
    activity: [{ messageId: "wait-result", items: [] }],
  });
  const expected = [{ ...result, activity: [] }];
  expect((await loadOlderChatHistoryPage(state, { cursor: "older-1" }))?.messages).toEqual(
    expected,
  );
  expect(
    await requestChatSessionSnapshot(state.client!, state.sessionKey, state, () => true),
  ).toMatchObject({ kind: "snapshot", snapshot: { messages: expected } });
  expect(result).not.toHaveProperty("activity");
});

it("requests the configured default agent for the global workspace alias", async () => {
  const state = createState({ messages: [] });
  Object.assign(state, {
    sessionKey: "workspace",
    assistantAgentId: "work",
    agentsList: { defaultId: "main", mainKey: "workspace", scope: "global" },
  });
  const request = vi.spyOn(state.client!, "request");
  await loadChatHistory(state);
  expect(request).toHaveBeenCalledWith(
    "chat.history",
    expect.objectContaining({ sessionKey: "workspace", agentId: "main" }),
    expect.anything(),
  );
});

it("rewinds cached history and restores only valid composer attachments", async () => {
  const kept = message("assistant", "kept prefix", { id: "kept", seq: 1 });
  const result = {
    editorText: "@Alex edit this",
    editorAttachments: [
      { mimeType: "image/png", data: "aW1hZ2U=" },
      { mimeType: "application/pdf", data: "aW1hZ2U=" },
      { mimeType: "image/png", data: "not base64!!" },
      { mimeType: "image/png", data: "A" },
    ],
  };
  const state = rewindState({ messages: [kept] }, Promise.resolve(result));
  state.sessionKey = "agent:main:rewind";
  state.chatMessages = [message("assistant", "stale tail")];
  state.chatMessage = "@Alex current draft";
  state.chatMentions = [{ profileId: "alex-profile", start: 0, end: 5 }];
  state.chatAttachments = [{ id: "old", mimeType: "image/jpeg", dataUrl: "data:old" }];
  const readCache = cached(state);
  expect(await rewind(state)).toEqual(result);
  expect(state.chatMessage).toBe(result.editorText);
  expect(state.chatMentions).toEqual([]);
  expect(state.chatAttachments).toEqual([
    {
      id: expect.stringMatching(/^att-/),
      mimeType: "image/png",
      dataUrl: "data:image/png;base64,aW1hZ2U=",
    },
  ]);
  expect(state.chatMessages).toEqual([kept]);
  expect(readCache()).toEqual([kept]);
});

it("invalidates a rewind's source cache without changing the newly selected draft", async () => {
  const state = rewindState({ messages: [] }, Promise.resolve({}));
  state.sessionKey = "agent:main:source";
  const source = state.sessionKey;
  cached(state, [message("assistant", "stale source tail")]);
  state.sessions.rewind.mockImplementation(async () => {
    state.sessionKey = "agent:main:next";
    return { editorText: "source draft" };
  });
  expect(await rewind(state)).toBeNull();
  expect(
    readChatMessagesFromCache(state.chatMessagesBySession!, state, { sessionKey: source }),
  ).toEqual([]);
  expect(state.handleChatDraftChange).not.toHaveBeenCalled();
});

it("reconciles committed rewind history without overwriting a replacement draft", async () => {
  const pending = createDeferred<SessionsRewindResult>();
  const canonical = message("assistant", "canonical history after rewind", {
    id: "canonical",
    seq: 1,
  });
  const state = rewindState({ messages: [canonical] }, pending.promise);
  const issued = createDeferred();
  state.sessions.rewind.mockImplementation(() => {
    issued.resolve();
    return pending.promise;
  });
  state.chatMessages = [message("assistant", "stale history")];
  const loading = rewind(state);
  await issued.promise;
  state.connectionEpoch += 2;
  state.chatMessage = "new connection draft";
  const attachments = [
    { id: "new", mimeType: "image/jpeg", dataUrl: "data:image/jpeg;base64,bmV3" },
  ];
  state.chatAttachments = attachments;
  pending.resolve({ editorText: "stale rewind draft" });
  expect(await loading).toBeNull();
  expect(state.chatMessage).toBe("new connection draft");
  expect(state.chatAttachments).toEqual(attachments);
  expect(state.chatMessages).toEqual([canonical]);
  expect(state.handleChatDraftChange).not.toHaveBeenCalled();
});

it("retries branch metadata after a reconnect read fails", async () => {
  const state = withSessions(
    { messages: [] },
    {
      listBranches: vi
        .fn()
        .mockRejectedValueOnce(new Error("gateway hiccup"))
        .mockResolvedValue([
          { leafEntryId: "tip", headline: "tip", messageCount: 1, active: true },
        ]),
    },
  );
  state.chatBranchesSessionKey = state.sessionKey;
  state.chatBranchesConnectionEpoch = state.connectionEpoch - 1;
  await loadChatHistory(state);
  expect(state.chatBranchesConnectionEpoch).toBe(state.connectionEpoch - 1);
  await loadChatHistory(state);
  expect(state.chatBranchesSessionKey).toBe(state.sessionKey);
  expect(state.chatBranchesConnectionEpoch).toBe(state.connectionEpoch);
  expect(state.chatBranches).toHaveLength(1);
});

it("rejects in-flight history after switching branches on the same session", async () => {
  const pending = createDeferred<ChatHistoryResult>();
  const old = message("assistant", "private old branch");
  const next = message("assistant", "selected branch", { id: "selected", seq: 1 });
  const state = withSessions({ messages: [next] }, { switchBranch: vi.fn().mockResolvedValue({}) });
  state.sessionKey = "agent:main:branches";
  state.chatMessages = [old];
  vi.spyOn(state.client!, "request")
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce({ messages: [next] });
  const loading = loadChatHistory(state);
  await expect(switchChatHistoryBranch(state, "selected-leaf")).resolves.toBe(true);
  expect(state.chatMessages).toEqual([next]);
  pending.resolve({ messages: [old] });
  await loading;
  expect(state.chatMessages).toEqual([next]);
});

it("reconciles a committed branch switch after a same-client reconnect", async () => {
  const pending = createDeferred<object>();
  const next = message("assistant", "selected branch after reconnect", { id: "selected", seq: 1 });
  const issued = createDeferred();
  const state = withSessions(
    { messages: [next] },
    {
      switchBranch: vi.fn(() => {
        issued.resolve();
        return pending.promise;
      }),
    },
  );
  state.chatMessages = [message("assistant", "stale branch")];
  const loading = switchChatHistoryBranch(state, "stale-leaf");
  await issued.promise;
  state.connectionEpoch += 2;
  pending.resolve({});
  await expect(loading).resolves.toBe(false);
  expect(state.chatMessages).toEqual([next]);
});

it("coalesces stale history while distinct peer messages update the transcript", async () => {
  const pending = createDeferred<ChatHistoryResult>();
  const first = message("user", "shared prompt", { id: "web", idempotencyKey: "web:user", seq: 1 });
  const second = message("user", "shared prompt", {
    id: "tui",
    idempotencyKey: "tui:user",
    seq: 2,
  });
  const reply = message("assistant", "finished reply", { id: "reply", seq: 3 });
  const state = createState({ messages: [reply], sessionId: "session" });
  state.currentSessionId = "session";
  state.chatDisplayedLeafEntryId = undefined;
  state.chatMessages = [reply];
  const scope = { sessionKey: state.sessionKey, sessionId: "session", activeLeafEntryId: null };
  const request = vi.spyOn(state.client!, "request").mockReturnValue(pending.promise);
  publishLive(state, first, scope);
  const firstLoad = loadChatHistory(state);
  publishLive(state, second, scope);
  const secondLoad = loadChatHistory(state);
  expect(request).toHaveBeenCalledOnce();
  expect(state.chatMessages).toEqual([first, second, reply]);
  pending.resolve({ messages: [reply], sessionId: "session" });
  await Promise.all([firstLoad, secondLoad]);
  expect(request).toHaveBeenCalledOnce();
  expect(state.chatMessages).toEqual([first, second, reply]);
});

it.each([
  { previousLeaf: null, nextLeaf: "next-leaf" },
  { previousLeaf: "previous-leaf", nextLeaf: null },
])(
  "never leaks transcript rows across $previousLeaf -> $nextLeaf",
  async ({ previousLeaf, nextLeaf }) => {
    const next = message("user", "selected branch", { id: "next", seq: 5 });
    const state = createState({
      messages: [next],
      hasMore: true,
      nextOffset: 2,
      totalMessages: 6,
      sessionInfo: {
        key: "main",
        kind: "direct",
        updatedAt: 1,
        sessionId: "session",
        activeLeafEntryId: nextLeaf,
      },
    });
    state.currentSessionId = "session";
    state.chatDisplayedLeafEntryId = previousLeaf;
    state.chatHistoryPagination = { hasMore: true, nextOffset: 2, totalMessages: 5 };
    state.chatMessages = [
      message("user", "private previous branch", { id: "previous", seq: 4 }),
      message("user", "private pending", { idempotencyKey: "old:user" }),
    ];
    publishLive(state, message("assistant", "private live reply", { id: "live", seq: 5 }), {
      sessionKey: state.sessionKey,
      sessionId: "session",
      activeLeafEntryId: previousLeaf,
    });
    await loadChatHistory(state);
    expect(state.chatMessages).toEqual([next]);
    expect(state.chatDisplayedLeafEntryId).toBe(nextLeaf);
  },
);

describe("full tail after a long live turn", () => {
  const prompt = message("user", "opening prompt", { id: "prompt", seq: 1 });
  const call = (seq: number) => message("assistant", `call ${seq}`, { id: `call-${seq}`, seq });
  const result = (seq: number) => ({
    role: "toolResult",
    content: [{ type: "text", text: `result ${seq}` }],
    __openclaw: { id: `result-${seq}`, seq },
  });
  const transcript = [prompt, call(2), result(3), call(4), result(5), call(6), call(7)];
  const sessionInfo = { key: "main", kind: "direct" as const, updatedAt: 1, sessionId: "session" };
  const tailFrom = (start: number, totalMessages = transcript.length) => ({
    messages: transcript.slice(start),
    hasMore: true,
    olderCursor: "older:tail",
    nextOffset: transcript.length - start,
    totalMessages,
    sessionInfo: { ...sessionInfo, hasActiveRun: false, status: "killed" as const },
  });

  async function loadAfterLiveTurn(
    tail: ChatHistoryResult,
    older: (cursor: string) => Promise<ChatHistoryResult>,
    {
      cursorReset = true,
      initialEnd = 1,
      previousLeaf,
      captureState,
      beforeRefresh,
    }: {
      cursorReset?: boolean;
      initialEnd?: number;
      previousLeaf?: string;
      captureState?: (state: TestState) => void;
      beforeRefresh?: (state: TestState) => void;
    } = {},
  ) {
    const state = createState(tail);
    state.currentSessionId = "session";
    state.chatDisplayedLeafEntryId = undefined;
    captureState?.(state);
    const pages: ChatHistoryResult[] = [
      {
        messages: transcript.slice(0, initialEnd),
        totalMessages: initialEnd,
        deltaCursor: "before-stop",
        sessionInfo: { ...sessionInfo, hasActiveRun: true, activeLeafEntryId: previousLeaf },
      },
      tail,
    ];
    const request = vi
      .spyOn(state.client!, "request")
      .mockImplementation(async (_method, params) => {
        const cursor = (params as { cursor?: string }).cursor;
        if (cursor?.startsWith("older:")) {
          return older(cursor);
        }
        // Stop persists an aborted reply, so the delta cursor resets to a bounded tail.
        return cursor === "before-stop" && cursorReset ? { kind: "reset" } : pages.shift();
      });
    await loadChatHistory(state);
    // Live rows carry assistant turns only; tool results arrive as activity.
    const scope = {
      sessionKey: state.sessionKey,
      sessionId: "session",
      activeLeafEntryId: previousLeaf ?? null,
    };
    for (const row of [call(2), call(4), call(6)]) {
      publishLive(state, row, scope);
    }
    beforeRefresh?.(state);
    await loadChatHistory(state);
    return { state, request };
  }

  it.each([
    ["after a row the pane never held", 2],
    ["at a row the pane held live", 3],
  ])("reads the gap when the tail starts %s", async (_case, start) => {
    const { state, request } = await loadAfterLiveTurn(tailFrom(start), async () => ({
      messages: transcript.slice(0, start),
      totalMessages: transcript.length,
      sessionInfo,
    }));
    expect(request).toHaveBeenCalledWith(
      "chat.history",
      expect.objectContaining({ cursor: "before-stop" }),
      expect.anything(),
    );
    expect(request).toHaveBeenCalledWith(
      "chat.history",
      expect.objectContaining({ cursor: "older:tail" }),
      expect.anything(),
    );
    expect(state.chatMessages).toEqual(transcript);
    const { segments, ...edges } = state.chatHistoryPagination;
    expect(edges).toEqual({ hasMore: false, totalMessages: 7 });
    expect(segments).toHaveLength(2);
    expect(segments?.every((packet) => packet.boundedPacket)).toBe(true);
  });

  it("restores the held prefix when Stop advances the leaf within the prior read", async () => {
    const tail = tailFrom(2);
    const older = vi.fn(async () => ({ messages: transcript.slice(0, 2), sessionInfo }));
    const { state } = await loadAfterLiveTurn(
      { ...tail, sessionInfo: { ...tail.sessionInfo, activeLeafEntryId: "stopped-leaf" } },
      older,
      { initialEnd: 4, previousLeaf: "running-leaf" },
    );
    expect(state.chatMessages).toEqual(transcript);
    expect(older).toHaveBeenCalledOnce();
    const { segments, ...edges } = state.chatHistoryPagination;
    expect(edges).toEqual({ hasMore: false, totalMessages: 7 });
    expect(segments).toHaveLength(2);
  });

  it("keeps the retryable boundary when the gap read fails", async () => {
    const { state } = await loadAfterLiveTurn(tailFrom(2), async () => {
      throw new Error("offline");
    });
    expect(state.chatMessages).not.toContainEqual(prompt);
    const { segments, ...edges } = state.chatHistoryPagination;
    expect(edges).toEqual({
      hasMore: true,
      olderCursor: "older:tail",
      nextOffset: 5,
      totalMessages: 7,
    });
    expect(segments).toHaveLength(1);
    expect(state.lastError).toBeNull();
  });

  it("keeps each fresh gap response's provenance instead of certifying an aggregate packet", async () => {
    const older = vi.fn(async (cursor: string): Promise<ChatHistoryResult> =>
      cursor === "older:tail"
        ? {
            messages: transcript.slice(2, 4),
            hasMore: true,
            olderCursor: "older:head",
            nextOffset: 5,
            totalMessages: 7,
            sessionInfo,
          }
        : { messages: transcript.slice(0, 2), totalMessages: 7, sessionInfo },
    );
    const { state, request } = await loadAfterLiveTurn(tailFrom(4), older);

    expect(state.chatMessages).toEqual(transcript);
    expect(older.mock.calls).toEqual([["older:tail"], ["older:head"]]);
    const segments = state.chatHistoryPagination.segments;
    // All seven rows would fit one certificate; only the three actual RPCs own one each.
    expect(segments?.map((packet) => packet.sources)).toEqual([
      ["id:prompt", "id:call-2"],
      ["id:result-3", "id:call-4"],
      ["id:result-5", "id:call-6", "id:call-7"],
    ]);
    expect(segments?.every((packet) => packet.boundedPacket)).toBe(true);
    for (const [method, params] of request.mock.calls) {
      if ((params as { cursor?: string }).cursor?.startsWith("older:")) {
        expect(method).toBe("chat.history");
        expect(params).toMatchObject({ limit: 80, maxBytes: 256 * 1024 });
      }
    }
  });

  it("keeps the fresh contiguous prefix and retry boundary when a later gap packet fails", async () => {
    const { state } = await loadAfterLiveTurn(tailFrom(4), async (cursor) => {
      if (cursor === "older:head") {
        throw new Error("offline");
      }
      return {
        messages: transcript.slice(2, 4),
        hasMore: true,
        olderCursor: "older:head",
        nextOffset: 5,
        totalMessages: 7,
        sessionInfo,
      };
    });

    expect(state.chatMessages).toEqual(transcript.slice(2));
    expect(state.chatHistoryPagination).toMatchObject({
      hasMore: true,
      olderCursor: "older:head",
      nextOffset: 5,
      totalMessages: 7,
    });
    expect(state.chatHistoryPagination.segments).toHaveLength(2);
    expect(state.lastError).toBeNull();
  });

  it.each(["selection", "claim"] as const)(
    "discards a held Stop-gap response after its %s retires",
    async (retirement) => {
      const entered = createDeferred();
      const pending = createDeferred<ChatHistoryResult>();
      let current: TestState | undefined;
      const reply = {
        messages: transcript.slice(2, 4),
        hasMore: true,
        olderCursor: "older:head",
        nextOffset: 5,
        totalMessages: 7,
        sessionInfo,
      };
      const loading = loadAfterLiveTurn(
        tailFrom(4),
        async () => {
          entered.resolve();
          return pending.promise;
        },
        { captureState: (state) => (current = state) },
      );
      await entered.promise;
      if (!current) {
        throw new Error("expected the held hydration owner");
      }
      const messages = current.chatMessages;
      const pagination = current.chatHistoryPagination;
      if (retirement === "selection") {
        current.sessionKey = "replacement";
      } else {
        beginHistoryRequest(current, current.client!, current.connectionEpoch, current.sessionKey);
      }
      pending.resolve(reply);
      const { state, request } = await loading;

      expect(state.chatMessages).toBe(messages);
      expect(state.chatHistoryPagination).toBe(pagination);
      expect(
        request.mock.calls.filter(([, params]) =>
          (params as { cursor?: string }).cursor?.startsWith("older:"),
        ),
      ).toHaveLength(1);
    },
  );

  it("keeps the fresh tail's lazy edge when a bounded gap packet cannot fit beside it", async () => {
    const tail = { ...tailFrom(4, 83), messages: [81, 82, 83].map(call) };
    const gap = Array.from({ length: 80 }, (_, index) =>
      Array.from({ length: 5 }, (_fragment, fragment) =>
        message("assistant", `gap ${index + 1} fragment ${fragment}`, {
          id: `gap-${index + 1}`,
          seq: index + 1,
        }),
      ),
    ).flat();
    expect(Buffer.byteLength(JSON.stringify(gap))).toBeLessThanOrEqual(256 * 1024);
    const older = vi.fn(async () => ({ messages: gap, totalMessages: 83, sessionInfo }));
    const { state, request } = await loadAfterLiveTurn(tail, older);

    expect(state.chatMessages).toEqual(tail.messages);
    expect(state.chatMessages.length).toBeLessThanOrEqual(400);
    expect(state.chatHistoryPagination).toMatchObject({
      hasMore: true,
      olderCursor: "older:tail",
      nextOffset: 3,
      totalMessages: 83,
    });
    expect(state.chatHistoryPagination.segments).toHaveLength(1);
    expect(state.chatHistoryPagination.segments?.[0]?.sources).toEqual([
      "id:call-81",
      "id:call-82",
      "id:call-83",
    ]);
    expect(older).toHaveBeenCalledOnce();
    expect(request.mock.calls.at(-1)?.[1]).toMatchObject({ limit: 80, maxBytes: 256 * 1024 });
    expect(state.lastError).toBeNull();
  });

  it("reserves local output when a Stop-gap packet would otherwise evict the accepted tail", async () => {
    const tail = { ...tailFrom(4, 83), messages: [81, 82, 83].map(call) };
    const output = {
      role: "system",
      content: "x".repeat(CHAT_RESIDENT_WEIGHT_TARGET - 128 * 1024),
    };
    const gap = Array.from({ length: 80 }, (_, index) =>
      message("assistant", "g".repeat(2 * 1024), { id: `gap-${index + 1}`, seq: index + 1 }),
    );
    expect(Buffer.byteLength(JSON.stringify(gap))).toBeLessThanOrEqual(256 * 1024);
    expect(prepareChatHistoryPacket(gap, { hasMore: false }).boundedPacket).toBe(true);
    const older = vi.fn(async () => ({ messages: gap, totalMessages: 83, sessionInfo }));
    const { state } = await loadAfterLiveTurn(tail, older, {
      beforeRefresh: (current) =>
        reduceChatSessionProjection(current, { type: "localOutput", message: output }),
    });

    expect(state.chatMessages).toEqual([output, ...tail.messages]);
    expect(JSON.stringify(state.chatMessages).length).toBeLessThanOrEqual(
      CHAT_RESIDENT_WEIGHT_TARGET,
    );
    expect(state.chatHistoryPagination).toMatchObject({
      hasMore: true,
      olderCursor: "older:tail",
      nextOffset: 3,
      totalMessages: 83,
    });
    expect(state.chatHistoryPagination.segments?.map((packet) => packet.sources)).toEqual([
      ["id:call-81", "id:call-82", "id:call-83"],
    ]);
    expect(state.chatHistoryPagination.segments?.[0]?.boundedPacket).toBe(true);
    expect(older).toHaveBeenCalledOnce();
  });

  it("preserves a detached head and its reader when Stop resets the tail cursor", async () => {
    const state = createState(tailFrom(4));
    state.currentSessionId = "session";
    state.chatDisplayedLeafEntryId = undefined;
    const head = {
      messages: transcript.slice(0, 2),
      newerCursor: "newer:head",
      totalMessages: 7,
      deltaCursor: "before-stop",
      sessionInfo: { ...sessionInfo, hasActiveRun: true },
    };
    const request = vi.spyOn(state.client!, "request").mockResolvedValueOnce(head);
    await loadChatHistory(state);
    expect(state.chatHistoryPagination).toMatchObject({
      hasMore: false,
      hasNewer: true,
      newerCursor: "newer:head",
    });
    const held = state.chatMessages;
    const coverage = state.chatHistoryPagination;
    const reader = vi.fn(() => "id:prompt");
    state.readTranscriptAnchorSource = reader;
    request
      .mockResolvedValueOnce({ kind: "reset" })
      .mockResolvedValueOnce(tailFrom(4))
      .mockResolvedValueOnce({ messages: transcript.slice(0, 4), totalMessages: 7, sessionInfo });

    await loadChatHistory(state);

    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[1]?.[1]).toMatchObject({ cursor: "before-stop" });
    expect(state.chatMessages).toEqual(held);
    expect(state.chatMessages[0]).toBe(held[0]);
    expect(state.chatHistoryPagination).toStrictEqual(coverage);
    expect(state.readTranscriptAnchorSource).toBe(reader);
    expect(state.readTranscriptAnchorSource()).toBe("id:prompt");
  });

  it.each([
    ["the full read did not follow a cursor reset", tailFrom(2), { cursorReset: false }],
    ["the gap exceeds one older page", tailFrom(2, 2000), {}],
  ])("keeps the lazy boundary when %s", async (_case, tail, options) => {
    const older = vi.fn(async () => ({ messages: transcript.slice(0, 2), sessionInfo }));
    const { state } = await loadAfterLiveTurn(tail, older, options);
    expect(older).not.toHaveBeenCalled();
    expect(state.chatHistoryPagination).toMatchObject({ hasMore: true, olderCursor: "older:tail" });
  });
});

it("clears live projection ownership after history access is denied", async () => {
  const state = createState({ messages: [] });
  const scopeError = missingScopeErrorShape({
    missingScope: "operator.read",
    requiredScopes: ["operator.read"],
  });
  vi.spyOn(state.client!, "request")
    .mockRejectedValueOnce(new GatewayRequestError(scopeError))
    .mockResolvedValueOnce({ messages: [] });
  publishLive(state, message("user", "private prompt", { id: "private", seq: 1 }));
  await loadChatHistory(state);
  expect(state.chatMessages).toEqual([]);
  await loadChatHistory(state);
  expect(state.chatMessages).toEqual([]);
});

it("materializes live commentary when history replaces active tool activity", async () => {
  const result = {
    role: "toolResult",
    toolCallId: "call-1",
    content: "tool output",
    timestamp: 3,
    __openclaw: { id: "tool-result", seq: 2 },
  };
  const state = createState({
    ...activeHistory("run-live"),
    messages: [
      { role: "user", content: "do it", timestamp: 1, __openclaw: { id: "user", seq: 1 } },
      result,
    ],
  });
  state.chatRunId = "run-live";
  state.settings = { ...state.settings, chatPersistCommentary: false };
  state.chatStreamSegments = [{ text: "Checking the workspace", ts: 2, itemId: "preamble-live" }];
  state.toolStreamOrder = ["call-1"];
  state.toolStreamById.set("call-1", {
    toolCallId: "call-1",
    runId: "run-live",
    name: "read",
    startedAt: 2,
    receivedAt: 2,
    message: result,
  });
  state.chatToolMessages = [result];
  await loadChatHistory(state);
  expect(state.chatMessages).toContainEqual(
    expect.objectContaining({
      openclawStreamFallback: expect.objectContaining({ itemId: "preamble-live" }),
    }),
  );
  expect(state.chatStreamSegments).toEqual([]);
});

describe("chat history run errors", () => {
  const row = (overrides: Partial<GatewaySessionRow> = {}): GatewaySessionRow => ({
    key: "main",
    kind: "direct",
    updatedAt: 2,
    status: "failed",
    hasActiveRun: false,
    lastRunId: "run",
    lastRunError: "Workspace preparation failed",
    ...overrides,
  });
  const notice = (content: string, details = {}, customType = "run-failed-before-reply") => ({
    role: "custom",
    customType,
    content,
    details,
    __openclaw: { id: "failure", seq: 1, runId: "run" },
  });
  function host(
    history: ChatHistoryResult | (() => ChatHistoryResult | Promise<ChatHistoryResult>),
  ) {
    const state = makeChatHost({
      sessionKey: "main",
      requestHandlers: { "chat.history": history },
    });
    onTestFinished(() => reconcileChatRunLifecycle(state, { clearRunStatus: true }));
    return state;
  }
  function emit(
    state: ReturnType<typeof host>,
    runId: string,
    event: Omit<ChatEventPayload, "sessionKey" | "runId">,
  ) {
    handleChatGatewayEvent(state, { sessionKey: "main", runId, ...event });
  }

  it.each([
    { snapshotStatus: "failed", newerState: "failed", requestOrder: "before" },
    { snapshotStatus: "done", newerState: "completed", requestOrder: "after" },
  ] as const)(
    "keeps newer $newerState over $snapshotStatus history requested $requestOrder it",
    async ({ snapshotStatus, newerState, requestOrder }) => {
      const response = createDeferred<ChatHistoryResult>();
      const state = host(() => response.promise);
      emit(
        state,
        "2",
        snapshotStatus === "done"
          ? { state: "final", message: { role: "assistant", content: "Old reply" } }
          : { state: "error", errorMessage: "Old failure" },
      );
      let loading = requestOrder === "before" ? loadChatHistory(state) : undefined;
      emit(state, "1", { state: "delta", deltaText: "New reply" });
      emit(
        state,
        "1",
        newerState === "completed"
          ? { state: "final", message: { role: "assistant", content: "New reply" } }
          : { state: "error", errorMessage: "Current full diagnostic" },
      );
      const currentError = state.chatRunError;
      loading ??= loadChatHistory(state);
      response.resolve({
        messages: [],
        sessionInfo: row({
          status: snapshotStatus,
          lastRunId: "2",
          lastRunError: snapshotStatus === "failed" ? "Old failure" : undefined,
        }),
      });
      await loading;
      expect(state.chatRunError).toEqual(currentError);
      expect(state.chatRunId).toBeNull();
    },
  );

  it("recovers a missed timeout after session publication settles the active run", async () => {
    const sessionInfo = row({ status: "timeout" });
    const state = host({ messages: [], sessionInfo });
    emit(state, "run", { state: "delta", deltaText: "Working" });
    reconcileChatRunFromSessionRow(state, sessionInfo, { publishRunStatus: false });
    expect(state.chatRunId).toBeNull();
    expect(state.chatRunError).toMatchObject({ runId: "run", summary: sessionInfo.lastRunError });
    await loadChatHistory(state);
    expect(state.chatRunError?.summary).toContain(sessionInfo.lastRunError);
    expect(getChatSessionProjection(state).runs.run).toMatchObject({
      status: "timeout",
      errorMessage: sessionInfo.lastRunError,
    });
  });

  it("preserves a same-run late diagnostic received during successful history", async () => {
    const response = createDeferred<ChatHistoryResult>();
    const state = host(() => response.promise);
    emit(state, "run", { state: "delta" });
    emit(state, "run", {
      state: "final",
      message: { role: "assistant", content: "Delivered answer" },
    });
    const loading = loadChatHistory(state);
    emit(state, "run", { state: "error", errorMessage: "Full late diagnostic after delivery" });
    const diagnostic = state.chatRunError;
    expect(diagnostic?.summary).toContain("Full late diagnostic after delivery");
    response.resolve({
      messages: [],
      sessionInfo: row({ status: "done", lastRunError: undefined }),
    });
    await loading;
    expect(state.chatRunError).toEqual(diagnostic);
    expect(state.chatRunId).toBeNull();
  });

  it("retains a newer-run diagnostic when a completed run delivers another final", () => {
    const state = host({ messages: [] });
    emit(state, "run", { state: "delta" });
    emit(state, "run", { state: "final", message: { role: "assistant", content: "First answer" } });
    emit(state, "newer-run", {
      state: "error",
      errorMessage: "Diagnostic that must remain visible",
    });
    const diagnostic = state.chatRunError;
    expect(diagnostic?.summary).toContain("Diagnostic that must remain visible");
    emit(state, "run", { state: "final", message: { role: "assistant", content: "Late answer" } });
    expect(state.chatMessages).toContainEqual(expect.objectContaining({ content: "Late answer" }));
    expect(state.chatRunId).toBeNull();
    expect(state.chatRunError).toEqual(diagnostic);
  });

  it("restores contention diagnostics separately from transcript text", async () => {
    const summary = "The turn was interrupted while the server was busy.";
    const diagnostic = "State lifecycle acquisition remained busy.";
    const state = host({
      messages: [notice(summary, { errorKind: "state_contention", diagnostic })],
      sessionInfo: row({ lastRunError: summary }),
    });
    await loadChatHistory(state);
    expect(state.chatRunError).toMatchObject({
      kind: "state_contention",
      runId: "run",
      summary: `${summary}\n\n${diagnostic}`,
    });
    expect(state.chatMessages).toContainEqual(expect.objectContaining({ content: summary }));
  });
});
