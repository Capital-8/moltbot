import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import type { ChatItem } from "../../../lib/chat/chat-types.ts";

export function SystemLine(props: {
  icon?: Extract<ChatItem, { kind: "divider" }>["icon"];
  label: string;
  children?: JSX.Element;
  metric?: string;
  compaction?: "active" | "complete";
}) {
  return (
    <div
      class="chat-divider__rule"
      role={props.compaction ? "status" : "separator"}
      aria-live={props.compaction ? "polite" : undefined}
      aria-label={props.metric ? `${props.label}, ${props.metric}` : props.label}
    >
      <span class="chat-divider__line" />
      <span class="chat-divider__label">
        <Show
          when={props.compaction}
          fallback={
            <Show when={props.icon}>
              {(icon) => (
                <span class="chat-divider__icon" aria-hidden="true">
                  <Icon name={icon()} />
                </span>
              )}
            </Show>
          }
        >
          <span class="chat-compaction__glyph" aria-hidden="true">
            <span class="chat-compaction__line" />
            <span class="chat-compaction__line" />
            <span class="chat-compaction__line" />
            <span class="chat-compaction__line" />
            <span class="chat-compaction__line" />
            <Icon name="check" />
          </span>
        </Show>
        <span class="chat-divider__title">{props.children ?? props.label}</span>
        <Show when={props.metric}>
          <span class="chat-divider__separator" aria-hidden="true">
            ·
          </span>
          <span class="chat-divider__metric">{props.metric}</span>
        </Show>
      </span>
      <span class="chat-divider__line" />
    </div>
  );
}

export function ChatDivider(props: { item: Extract<ChatItem, { kind: "divider" }> }) {
  return (
    <div
      class={[
        "chat-divider",
        props.item.compaction ? `chat-compaction chat-compaction--${props.item.compaction}` : "",
      ]}
      data-chat-row-key={props.item.key}
      data-ts={String(props.item.timestamp)}
    >
      <SystemLine
        icon={props.item.icon}
        label={props.item.label}
        metric={props.item.metric}
        compaction={props.item.compaction}
      />
      <Show when={props.item.description}>
        <div class="chat-divider__details">
          <span class="chat-divider__description">{props.item.description}</span>
        </div>
      </Show>
    </div>
  );
}
