import type { UiPreferences } from "../../app/settings.ts";
import { isChatBubbleMode } from "./chat-bubble-mode.ts";
import { projectChatReasoning } from "./chat-reasoning.ts";
import { buildChatItems } from "./chat-thread-build.ts";
import { buildChatArchiveNotice } from "./components/chat-divider.ts";
import { projectTranscriptChain } from "./components/chat-transcript-message-index.ts";
import { prepareTranscriptRows } from "./components/chat-transcript-preparation.ts";
import type { ChatSessionSnapshot } from "./session-message-cache.ts";

export function prepareCachedTranscript(
  snapshot: ChatSessionSnapshot,
  sessionKey: string,
  settings: UiPreferences,
  chatBubblesEnabled: boolean,
  mainKey: string,
): Promise<void> | undefined {
  const bubbleMode = isChatBubbleMode(settings, sessionKey, chatBubblesEnabled, mainKey);
  const items = buildChatItems({
    paneId: "snapshot-prewarm",
    sessionKey,
    archiveNotice: buildChatArchiveNotice(
      snapshot.transcriptMetadata ?? snapshot.historyState?.sessionInfo,
    ),
    messages: snapshot.messages,
    pendingInputs: snapshot.historyState?.pendingInputs?.items,
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    showToolCalls: settings.chatShowToolCalls,
    showReasoning: projectChatReasoning({
      showThinking: settings.chatShowThinking,
      selectedSession: snapshot.historyState?.sessionInfo,
    }).showReasoning,
    persistCommentary: settings.chatPersistCommentary,
  });
  const chain = projectTranscriptChain(items, {
    sessionKey,
    messages: snapshot.messages,
    runWorking: false,
    searchActive: false,
    bubbleMode,
    session: snapshot.transcriptMetadata,
  });
  const preparation = prepareTranscriptRows(
    chain.transcriptItems.map((item) => ({ kind: "item", key: item.key, item })),
    { bubbleMode },
  );
  return preparation && !preparation.ready() ? preparation.load() : undefined;
}
