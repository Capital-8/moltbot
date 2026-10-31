/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createComposerContainer } from "./chat-composer.test-support.ts";
import * as chatThread from "./chat-thread.ts";
import { resetChatViewState } from "./chat-view-state.test-support.ts";
import { renderChatInto, requireElement } from "./chat-view.test-helpers.ts";
import { chatRichPresentation } from "./components/chat-rich-presentation.ts";
import {
  flushDeferredRowPrune,
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(() => {
  resetChatViewState();
  resetTranscriptTestDom();
});

describe("chat status ownership", () => {
  it("releases the embedded status when later work steals ownership from an unchanged reply", async () => {
    // Rows memoize on their own item identity, so an unchanged reply that
    // stops owning the status must still re-render without it.
    const replyGroup = {
      kind: "group",
      key: "group:assistant:reply",
      role: "assistant",
      visibleContent: "text",
      messages: [
        {
          key: "message:assistant:reply",
          message: { role: "assistant", content: "Interim answer", timestamp: 1 },
        },
      ],
      timestamp: 1,
      isStreaming: false,
    };
    const readingIndicator = { kind: "reading-indicator", key: "reading:test", startedAt: 1 };
    const toolGroup = {
      kind: "group",
      key: "group:tool:later",
      role: "tool",
      visibleContent: "text",
      messages: [
        {
          key: "message:tool:later",
          message: { role: "tool", content: "Later tool result", timestamp: 2 },
        },
      ],
      timestamp: 2,
      isStreaming: false,
    };
    const props = {
      canAbort: true,
      messages: [{ role: "assistant", content: "Interim answer", timestamp: 1 }],
      stream: null,
    };
    const container = createComposerContainer();
    const buildItems = vi.spyOn(chatThread, "buildCachedChatItems");

    buildItems.mockReturnValue([replyGroup, readingIndicator] as ReturnType<
      typeof chatThread.buildCachedChatItems
    >);
    renderChatInto(container, props);
    await flushDeferredRowPrune();
    const bubble = requireElement(
      container,
      '[data-message-id="message:assistant:reply"]',
      "retained assistant reply",
    );
    const reply = expectDefined(bubble.closest(".chat-group"), "assistant group");
    expect(reply.querySelector(".chat-working-indicator--continuation")).not.toBeNull();

    buildItems.mockReturnValue([replyGroup, toolGroup, readingIndicator] as ReturnType<
      typeof chatThread.buildCachedChatItems
    >);
    renderChatInto(container, props);

    // Status ownership updates after the new tool row's presentation is ready.
    await chatRichPresentation.load();
    await waitForSolid(() => expect(reply.querySelector(".chat-working-indicator")).toBeNull());
    expect(container.querySelector('[data-message-id="message:assistant:reply"]')).toBe(bubble);
    expect(container.querySelectorAll(".chat-working-indicator")).toHaveLength(1);
  });
});
