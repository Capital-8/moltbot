/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { loadChatHistory, restoreChatHistoryBookmark } from "../chat-history.ts";
import { nativeHistoryMessage } from "../chat-pane-history.test-support.ts";
import { residentPane } from "../chat-pane-resident.test-support.ts";
import { buildMessageItems } from "../chat-thread-items.ts";
import { stubAnimationFrames } from "../chat-view.test-helpers.ts";
import {
  handleChatScrollTakeover,
  saveChatSessionScrollPosition,
  type ChatReadingBookmark,
} from "../scroll.ts";
import {
  mountTestTranscript,
  numberedContentRows,
} from "../test-helpers/chat-transcript-native.tsx";
import { createChatTranscript } from "./chat-transcript-controller.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./chat-transcript.test-support.ts";

let frames: ReturnType<typeof stubAnimationFrames>;
beforeEach(() => {
  installTranscriptDomMocks();
  frames = stubAnimationFrames();
});
afterEach(resetTranscriptTestDom);

async function heldBookmark(paneId: string) {
  const { state } = residentPane();
  await loadChatHistory(state);
  const message = nativeHistoryMessage(80, "body-80");
  Object.assign(message["__openclaw"], { id: "source-80" });
  const saved: ChatReadingBookmark = {
    sessionId: "resident-session",
    source: "id:source-80",
    messageId: "source-80",
    messageKey: buildMessageItems([message])[0]!.key,
    rowKey: null,
    offset: -25,
  };
  saveChatSessionScrollPosition(paneId, `agent:main:${paneId}`, {
    scrollTop: 420,
    anchorToEnd: false,
    bookmark: saved,
  });
  const held = createDeferred<boolean>();
  const client = state.client!;
  const request = client.request.bind(client);
  let requested = false;
  client.request = async (...args) => {
    requested = true;
    if (!(await held.promise)) {
      throw new Error("Bookmark read interrupted");
    }
    return request(...args);
  };
  let restoring: Promise<boolean> | undefined;
  const restore = vi.fn((bookmark: typeof saved, isCurrent: () => boolean) => {
    restoring = restoreChatHistoryBookmark(state, bookmark, isCurrent);
    return restoring;
  });
  const transcript = createChatTranscript(() => paneId, {
    getSessionId: () => state.currentSessionId ?? null,
    restoreBookmark: restore,
    onReaderScroll: (towardEnd) => handleChatScrollTakeover(state, towardEnd),
  });
  state.chatCancelScroll = () => transcript.cancelScroll();
  const view = await mountTestTranscript(paneId, numberedContentRows(20), transcript);
  state.chatScrollElement = () => view.container;
  view.session.layout.ready = true;
  transcript.update();
  await waitForSolid(() => {
    expect(restore).toHaveBeenCalledOnce();
    expect(requested).toBe(true);
  });
  return { state, transcript, view, held, restore, result: () => restoring! };
}

it.each(["Latest", "reader takeover"])(
  "retires a held bookmark at %s intent before deferred scrolling",
  async (action) => {
    const { state, transcript, view, held, result } = await heldBookmark(`bookmark-${action}`);
    const retained = state.chatMessages;
    if (action === "Latest") {
      state.scrollToBottom();
    } else {
      view.container.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
    }
    // Settle before afterCommit/rAF, so deferred scroll cannot supply the fence.
    held.resolve(true);
    expect(await result()).toBe(false);
    expect(state.chatMessages).toBe(retained);
    expect(state.lastError).toBeNull();
    transcript.dispose();
  },
);

it("settles a disconnected bookmark and allows the same host to reconnect", async () => {
  const { transcript, view, held, result, restore } = await heldBookmark("bookmark-reconnect");
  transcript.dispose();
  held.resolve(false);
  expect(await result()).toBe(false);
  transcript.start();
  view.renderRows(numberedContentRows(20));
  frames();
  flush();
  await waitForSolid(() => expect(transcript.isPositionSettled).toBe(true));
  expect(restore).toHaveBeenCalledOnce();
  transcript.dispose();
});
