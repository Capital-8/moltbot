import { For, Show } from "solid-js";
import "../../../styles/chat/composer-queue-content.css";
import type {
  SessionSharingRole,
  SessionSuggestion,
  SessionSuggestionResolution,
} from "../../../../../packages/gateway-protocol/src/index.js";
import { IconButton } from "../../../components/solid/icon-button.tsx";
import type { IconName } from "../../../components/solid/icon.tsx";
import { createTextOverflow } from "../../../components/solid/text-overflow.ts";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { t, registerEnglishCatalog } from "../../../lib/reactive/i18n.ts";
import { ChatAuthorAvatar } from "./chat-author-avatar.ts";

registerEnglishCatalog(registerChatSessionEnglish);

const actions: readonly [SessionSuggestionResolution, string, IconName][] = [
  ["send", "sendNow", "arrowUp"],
  ["queue", "queue", "check"],
  ["edit", "edit", "edit"],
  ["dismiss", "dismiss", "trash"],
];

export function ChatSessionSuggestions(props: {
  suggestions: readonly SessionSuggestion[];
  role?: SessionSharingRole;
  busyIds: ReadonlySet<string>;
  archived: boolean;
  canResolve: boolean;
  onResolve: (suggestion: SessionSuggestion, resolution: SessionSuggestionResolution) => void;
}) {
  const canResolve = () => props.canResolve && (props.role === "owner" || props.role === "admin");
  return (
    <Show when={props.suggestions.length > 0}>
      <div class="chat-queue session-suggestions" aria-live="polite">
        <For each={props.suggestions} keyed={(suggestion) => suggestion.id}>
          {(suggestion) => {
            const author = () => suggestion().author.label ?? suggestion().author.id;
            // Suggestion authors are Gateway identities, like queued sends and sent user turns.
            const sender = () => ({
              id: suggestion().author.id,
              name: author(),
              identity: suggestion().author.identity ?? {
                type: "profile" as const,
                id: suggestion().author.id,
              },
              profileAvatarUrl: suggestion().author.avatarUrl,
            });
            const awaitingApproval = () =>
              (props.role === "viewer" || props.role === "member") &&
              suggestion().state === "pending";
            return (
              <article
                class="chat-queue__item session-suggestion"
                data-suggestion-id={suggestion().id}
              >
                <ChatAuthorAvatar sender={sender()} />
                <span class="chat-queue__copy">
                  <span
                    class="chat-queue__text"
                    title={`${author()}: ${suggestion().text}`}
                    ref={createTextOverflow(() => suggestion().text)}
                  >
                    <b class="session-suggestion__author">{author()}</b>{" "}
                    <span class="session-suggestion__text">{suggestion().text}</span>
                  </span>
                </span>
                <span class="chat-queue__actions">
                  <Show
                    when={canResolve() && suggestion().state === "pending"}
                    fallback={
                      <small class="chat-queue__state session-suggestion__state">
                        {awaitingApproval()
                          ? t("chat.sessionSuggestions.awaitingApproval")
                          : t(`chat.sessionSuggestions.state.${suggestion().state}`)}
                      </small>
                    }
                  >
                    <For each={actions}>
                      {(action) => (
                        <Show when={!props.archived || action[0] === "dismiss"}>
                          <IconButton
                            size={28}
                            glyph="row"
                            class="session-suggestion__action"
                            icon={action[2]}
                            label={t(`chat.sessionSuggestions.${action[1]}`, {
                              author: author(),
                            })}
                            tooltip={t(`chat.sessionSuggestions.${action[1]}`, {
                              author: author(),
                            })}
                            disabled={props.busyIds.has(suggestion().id)}
                            onClick={() => props.onResolve(suggestion(), action[0])}
                          />
                        </Show>
                      )}
                    </For>
                  </Show>
                </span>
              </article>
            );
          }}
        </For>
      </div>
    </Show>
  );
}
