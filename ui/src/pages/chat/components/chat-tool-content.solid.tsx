import { lazy } from "solid-js";
import { registerChatToolLabelsEnglish } from "../../../i18n/locales/en-chat-tool-labels.ts";
import type { ToolCard, ToolCardOutcome } from "../../../lib/chat/chat-types.ts";
import { t, registerEnglishCatalog } from "../../../lib/reactive/i18n.ts";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";
import type { ToolRenderOptions } from "./chat-tool-render-model.ts";

registerEnglishCatalog(registerChatToolLabelsEnglish);

const ExpandedContent = lazy(() => import("./chat-tool-expanded.solid.tsx"), {
  export: "ExpandedToolCardContent",
});

export function ExpandedToolCardContent(props: { card: ToolCard; options: ToolRenderOptions }) {
  return (
    <ChatLazyBoundary>
      <ExpandedContent {...props} />
    </ChatLazyBoundary>
  );
}

export function ToolOutcome(props: { outcome: ToolCardOutcome; exitCode?: number }) {
  const label = () =>
    props.outcome === "failed" && props.exitCode !== undefined && props.exitCode !== 0
      ? t("chat.toolCards.exitCode", { code: String(props.exitCode) })
      : t(
          `chat.toolCards.${props.outcome === "succeeded" ? "completed" : props.outcome === "unknown" ? "outcomeUnknown" : props.outcome === "unrecorded" ? "noResult" : props.outcome}`,
        );
  return <div class="chat-tool-card__outcome">{label()}</div>;
}
