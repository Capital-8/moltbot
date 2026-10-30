import { For, Show } from "solid-js";
import type { MessageContentProps } from "./chat-message-bubble-presentation.ts";
import { ToolPreview } from "./chat-message-deferred.tsx";
import { RawOutputToggle } from "./chat-tool-raw-output.tsx";

export function AssistantViews(props: MessageContentProps) {
  const messageTimestamp = () => {
    const value = props.state().m.timestamp;
    return typeof value === "number" ? value : undefined;
  };
  return (
    <Show when={props.state().sourceRole === "assistant"}>
      <For each={props.state().assistantViewBlocks} keyed={false}>
        {(block) => {
          let rawToggle: HTMLButtonElement | undefined;
          return (
            <div class="chat-tool-card__widget-host">
              <ToolPreview
                preview={block().preview}
                surface="chat_message"
                options={{
                  rawText: block().rawText ?? null,
                  toggleRawDetails: () => {
                    const open = rawToggle?.getAttribute("aria-expanded") !== "true";
                    rawToggle?.click();
                    return Boolean(rawToggle && open);
                  },
                  canvasPluginSurfaceUrl: props.options.canvasPluginSurfaceUrl,
                  mediaReadAllowed: props.options.mediaReadAllowed,
                  boardProvider: props.options.boardProvider,
                  widgetLayout: props.options.widgetLayout,
                  embedSandboxMode: props.options.embedSandboxMode ?? "scripts",
                  allowExternalEmbedUrls: props.options.allowExternalEmbedUrls,
                  sessionKey: props.options.sessionKey,
                  messageTimestamp: messageTimestamp(),
                }}
              />
              <Show when={block().rawText}>
                <div class="chat-tool-card__widget-raw">
                  <openclaw-chat-tool-raw style={{ display: "contents" }}>
                    <RawOutputToggle
                      text={block().rawText!}
                      toggleRef={(element) => (rawToggle = element)}
                    />
                  </openclaw-chat-tool-raw>
                </div>
              </Show>
            </div>
          );
        }}
      </For>
    </Show>
  );
}
