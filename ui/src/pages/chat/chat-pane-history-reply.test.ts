/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { createGatewayBrowserClientFixture } from "./chat-application-context.test-support.ts";
import { createTestChatPane, nativeHistoryMessage } from "./chat-pane-history.test-support.ts";
import { flushDeferredRowPrune } from "./components/chat-transcript.test-support.ts";

const sourceId = "source-message";
const message = { role: "assistant", content: "Original answer", __openclaw: { id: sourceId } };
const pair = (last: number) => [last - 1, last].map((seq) => nativeHistoryMessage(seq));
const page = (messages: unknown[], totalMessages = 4, hasMore = false, nextOffset?: number) => ({
  messages,
  totalMessages,
  hasMore,
  ...(nextOffset === undefined ? {} : { olderCursor: `older-${nextOffset}` }),
});

function fixture(request = vi.fn(), last = 4) {
  const result = createTestChatPane({
    client: createGatewayBrowserClientFixture({ request }),
    sessions: {} as SessionCapability,
  });
  result.state.currentSessionId = "reply-session";
  result.state.chatMessages = pair(last);
  result.state.chatHistoryPagination = {
    hasMore: true,
    olderCursor: "older-2",
    totalMessages: last,
  };
  return result;
}

it.each([
  { result: { ok: true, message }, expected: undefined },
  { result: undefined, expected: "pending" },
  { result: { ok: false, unavailableReason: "oversized" }, expected: "oversized" },
  { result: { ok: false, unavailableReason: "not_found" }, expected: "missing" },
])("keeps reply availability through reconnect ($expected)", ({ result, expected }) => {
  const request = vi.fn();
  const { pane, state } = fixture(request);
  state.chatMessages = [
    {
      role: "user",
      content: "Follow-up",
      __openclaw: { replyToId: sourceId, replyToMessage: result },
    },
  ];
  expect(pane.replyMessageStatus(sourceId)).toBe(expected);
  expect(pane.readReplyMessage(sourceId)).toBe(result?.message);
  pane.connectionGeneration += 1;
  state.connectionEpoch = pane.connectionGeneration;
  expect(pane.readReplyMessage(sourceId)).toBe(result?.message);
  expect(state.chatMessages).toHaveLength(1);
  expect(request).not.toHaveBeenCalled();
  state.chatMessages = [];
  expect(pane.readReplyMessage(sourceId)).toBeUndefined();
});

it.each([true, false])(
  "finds paginated replies or reports exhaustion (found: %s)",
  async (found) => {
    const target = {
      ...nativeHistoryMessage(1, "Original answer"),
      __openclaw: { id: sourceId, seq: 1 },
    };
    const request = vi.fn();
    request.mockResolvedValueOnce({
      messages: found ? [target] : [],
      sessionId: "reply-session",
      ...(found ? {} : { windowReset: true }),
    });
    if (!found) {
      request.mockResolvedValueOnce({
        ...page(pair(4), 4, true, 2),
        sessionId: "reply-session",
      });
    }
    const { pane, state } = fixture(request, found ? 6 : 4);
    const messageId = found ? sourceId : "missing-message";
    vi.spyOn(pane, "updateComplete", "get").mockReturnValue(Promise.resolve(true));
    const revealMessage = vi.spyOn(pane.transcript, "revealMessage").mockReturnValue(true);
    void pane.openReplyMessage(messageId);
    if (found) {
      expect(pane.currentReplyNavigationId(state.sessionKey)).toBe(sourceId);
      await vi.waitFor(() => expect(revealMessage).toHaveBeenCalledWith(sourceId));
      expect(request).toHaveBeenCalledExactlyOnceWith(
        "chat.history",
        {
          sessionKey: state.sessionKey,
          sessionId: "reply-session",
          messageId: sourceId,
          limit: 1,
          maxBytes: 256 * 1024,
          toolResultMaxChars: 2_000,
        },
        { signal: expect.any(AbortSignal) },
      );
    } else {
      await vi.waitFor(() => expect(state.lastError).toBe("The original message is unavailable."));
      expect(revealMessage).not.toHaveBeenCalled();
    }
    expect(pane.currentReplyNavigationId(state.sessionKey)).toBeNull();
  },
);

it("abandons reply navigation when the pane switches sessions", async () => {
  const deferred = createDeferred<ReturnType<typeof page>>();
  const request = vi.fn(() => deferred.promise);
  const { pane, state } = fixture(request);
  const revealMessage = vi.spyOn(pane.transcript, "revealMessage");
  void pane.openReplyMessage(sourceId);
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  state.sessionKey = "agent:main:other";
  pane.resetOlderMessagesViewport();
  deferred.resolve(page([]));
  await deferred.promise;
  await flushDeferredRowPrune();
  expect(pane.currentReplyNavigationId(state.sessionKey)).toBeNull();
  expect(revealMessage).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledOnce();
});

it.each(["session", "agent", "connection"])(
  "retires a held reply reset across a successor %s",
  async (successor) => {
    const deferred = createDeferred<ReturnType<typeof page>>();
    const request = vi
      .fn()
      .mockResolvedValueOnce({ messages: [], windowReset: true })
      .mockImplementationOnce(() => deferred.promise);
    const { pane, state } = fixture(request);
    const reveal = vi.spyOn(pane.transcript, "revealMessage");
    if (successor === "agent") {
      state.sessionKey = "global";
      state.assistantAgentId = "main";
    }
    const navigation = pane.openReplyMessage(sourceId);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    if (successor === "session") {
      state.sessionKey = "agent:main:other";
    } else if (successor === "agent") {
      state.assistantAgentId = "other";
    } else {
      state.connectionEpoch += 1;
    }
    state.lastError = "successor error";
    deferred.resolve(page(pair(4)));
    await navigation;
    expect(state.lastError).toBe("successor error");
    expect(reveal).not.toHaveBeenCalled();
  },
);

it("makes a reply lookup superseded by same-session history visibly retryable", async () => {
  const deferred = createDeferred<ReturnType<typeof page>>();
  const request = vi
    .fn()
    .mockImplementationOnce(() => deferred.promise)
    .mockResolvedValueOnce({ ...page(pair(4)), sessionId: "reply-session" });
  const { pane, state } = fixture(request);
  const navigation = pane.openReplyMessage(sourceId);
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  const { loadChatHistory } = await import("./chat-history.ts");
  await loadChatHistory(state, { deferBranches: true, supersedeInFlight: true });
  deferred.resolve(page([]));
  await navigation;
  expect(state.lastError).toBe("History refreshed before this page loaded. Try again.");
});
