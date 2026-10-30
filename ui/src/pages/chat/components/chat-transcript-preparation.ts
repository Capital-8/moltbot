import { messageRecoveryKey } from "../chat-message-recovery.ts";
import type { buildCachedChatItems } from "../chat-thread.ts";
import { messageNeedsRichPresentation } from "./chat-message-bubble-presentation.ts";
import type { ChatThreadProps } from "./chat-thread-interactions.ts";
import { resolveTranscriptAvatarPlacement } from "./chat-transcript-identity.ts";
import { projectTranscriptRowConfiguration } from "./chat-transcript-layout-owner.ts";
import type { ChatTranscriptSession, TranscriptPreparation } from "./chat-transcript-session.ts";

/** Project candidate readiness without changing the accepted row geometry. */
export function projectTranscriptPreparation(
  props: ChatThreadProps,
  transcript: ChatTranscriptSession,
  chatItems: ReturnType<typeof buildCachedChatItems>,
  options: {
    transcriptItemCount: number;
    hasLiveContent: boolean;
    hasTypingActors: boolean;
    searchOpen: boolean;
    transient: boolean;
    richRowKeys: ReadonlySet<string>;
    liveRichRowKey?: string;
    messageRowKeysById: ReadonlyMap<string, string>;
  },
) {
  // An empty page can still expose earlier history through its boundary.
  const isEmpty =
    options.transcriptItemCount === 0 &&
    !props.loading &&
    !options.hasLiveContent &&
    (!props.historyPagination?.hasMore || options.searchOpen);
  const showLoadingSkeleton =
    props.loading && options.transcriptItemCount === 0 && !options.hasTypingActors;
  const identity = resolveTranscriptAvatarPlacement(props, chatItems);
  const rowConfiguration = projectTranscriptRowConfiguration(
    props,
    identity.avatarPlacement,
    options.transient,
  );
  let additionalRichRowKeys: Set<string> | undefined;
  if (options.liveRichRowKey && !options.richRowKeys.has(options.liveRichRowKey)) {
    (additionalRichRowKeys ??= new Set(options.richRowKeys)).add(options.liveRichRowKey);
  }
  if (transcript.expandedAssistantMessages.size) {
    for (const [messageId, rowKey] of options.messageRowKeysById) {
      const expansion = transcript.expandedAssistantMessages.get(
        messageRecoveryKey(props.fullMessageAgentId, messageId),
      );
      if (
        !options.richRowKeys.has(rowKey) &&
        expansion?.status === "loaded" &&
        messageNeedsRichPresentation(expansion.message)
      ) {
        (additionalRichRowKeys ??= new Set(options.richRowKeys)).add(rowKey);
      }
    }
  }
  if (isEmpty || showLoadingSkeleton) {
    // Empty shells have no row candidate waiting for admission.
    transcript.layout.configureRows(props, identity.avatarPlacement, options.transient);
  }
  return {
    ...identity,
    isEmpty,
    showLoadingSkeleton,
    presented:
      typeof props.presented === "object"
        ? props.presented.isPresented()
        : (props.presented ?? true),
    preparation: {
      richRowKeys: additionalRichRowKeys ?? options.richRowKeys,
      rowConfiguration,
    } satisfies TranscriptPreparation,
  };
}
