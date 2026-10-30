import { lazy, lazyModule } from "solid-js";

export const AsyncQuestionSummary = lazy(() => import("./chat-rich-presentation.runtime.ts"), {
  export: "AsyncQuestionSummary",
});
export const BubbleToolCards = lazy(() => import("./chat-rich-presentation.runtime.ts"), {
  export: "BubbleToolCards",
});
export const InlineToolCards = lazy(() => import("./chat-rich-presentation.runtime.ts"), {
  export: "InlineToolCards",
});
export const ToolMessage = lazy(() => import("./chat-rich-presentation.runtime.ts"), {
  export: "ToolMessage",
});
export const MessageWorkContext = lazy(() => import("./chat-rich-presentation.runtime.ts"), {
  export: "MessageWorkContext",
});
export const WorkspaceConflictTranscriptMessage = lazy(
  () => import("./chat-rich-presentation.runtime.ts"),
  { export: "WorkspaceConflictTranscriptMessage" },
);
export const ActivityGroupContent = lazy(() => import("./chat-rich-presentation.runtime.ts"), {
  export: "ActivityGroupContent",
});

// One admitted family; component preloads also settle Solid's own lazy readers.
const preparation = lazyModule(async () => {
  await Promise.all([
    AsyncQuestionSummary.preload(),
    BubbleToolCards.preload(),
    InlineToolCards.preload(),
    ToolMessage.preload(),
    MessageWorkContext.preload(),
    WorkspaceConflictTranscriptMessage.preload(),
    ActivityGroupContent.preload(),
  ]);
  return {};
});

export const chatRichPresentation = {
  ready: () => preparation.peek() !== undefined,
  load: preparation,
};
