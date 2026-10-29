import {
  nativeHistoryMessageSourceId,
  nativeHistoryMessageSourceIdentity,
} from "../../lib/chat/history-message-identity.ts";
import { scopedAgentParamsForSession } from "../../lib/sessions/navigation.ts";
import { getChatPendingInputs } from "./chat-pending-inputs.ts";
import type { ChatState } from "./chat-state-contract.ts";
import { buildMessageItems } from "./chat-thread-items.ts";
import { resetChatThreadState } from "./chat-thread.ts";
import type { ChatTranscript } from "./components/chat-transcript-controller.ts";
import { captureChatSessionScrollPosition, saveChatSessionScrollPosition } from "./scroll.ts";

export function retireChatTranscriptSources(
  paneId: string,
  transcript: ChatTranscript,
  state: ChatState | null | undefined,
  messages: readonly unknown[],
): void {
  resetChatThreadState(paneId, messages);
  if (state) {
    const pending = getChatPendingInputs(state);
    // Parked panes do not project recovery. Source retirement must release
    // loaded bodies and invalidate pending completions without waiting for reveal.
    transcript.pruneRecovery(state.sessionKey, {
      fullMessageAgentId: scopedAgentParamsForSession(state, state.sessionKey).agentId,
      messages: state.chatMessages,
      toolMessages: state.chatToolMessages,
      pendingInputs: pending ? [...pending.page.items, ...pending.queuedInputs] : undefined,
    });
  }
}

/** A reader pins its contiguous source segment, never a detached body island. */
export function readChatTranscriptAnchorSource(
  state: ChatState | null | undefined,
  transcript: ChatTranscript,
): string | null {
  const viewport = transcript.scrollElement;
  const elements = transcript.messageElements?.elements;
  if (!state || !viewport || !elements) {
    return null;
  }
  const rect = viewport.getBoundingClientRect();
  const held = buildMessageItems(state.chatMessages).find((item) => {
    const element = elements.get(item.key);
    if (!element || !viewport.contains(element)) {
      return false;
    }
    const bubble = element.getBoundingClientRect();
    return bubble.bottom > rect.top && bubble.top < rect.bottom;
  });
  return nativeHistoryMessageSourceIdentity(held?.message);
}

export function saveChatTranscriptReadingPosition(
  paneId: string,
  sessionKey: string,
  state: ChatState | null | undefined,
  transcript: ChatTranscript,
  viewport: { scrollTop: number; scrollHeight: number; clientHeight: number },
): void {
  const captured = captureChatSessionScrollPosition(viewport);
  // A detached window's physical bottom is not the transcript tail.
  const position = {
    ...captured,
    anchorToEnd: captured.anchorToEnd && !state?.chatHistoryPagination.hasNewer,
  };
  const anchor = !position.anchorToEnd && transcript.captureBookmark();
  const message =
    anchor &&
    buildMessageItems(state?.chatMessages ?? []).find((item) => item.key === anchor.messageKey)
      ?.message;
  const source = nativeHistoryMessageSourceIdentity(message);
  const messageId = nativeHistoryMessageSourceId(message);
  const sessionId = state?.currentSessionId;
  saveChatSessionScrollPosition(paneId, sessionKey, {
    ...position,
    ...(anchor && source && messageId && sessionId
      ? { bookmark: { ...anchor, source, messageId, sessionId } }
      : {}),
  });
}
