import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
import { SettingsRow, SettingsStatus, SettingsValue } from "../../components/solid/settings-ui.tsx";
import { useApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { DiscordIdentityState } from "./discord-identity-state.ts";

export function DiscordIdentity() {
  const context = useApplication();
  const [revision, publish] = createSignal(0, { ownedWrite: true });
  const state = new DiscordIdentityState(() => publish((value) => value + 1));
  const view = createMemo(() => {
    revision();
    return {
      accounts: state.accounts,
      selected: state.selected,
      accountId: state.accountId,
      loading: state.loading,
      busy: state.busy,
      available: state.available,
      flow: state.flow,
      error: state.error,
    };
  });
  onSettled(() => {
    const stop = context.gateway.subscribe((snapshot) => state.sync(snapshot));
    const stopEvents = context.gateway.subscribeEvents((event) => {
      if (
        event.event === "sessions.changed" &&
        asOptionalRecord(event.payload)?.reason === "profile-identity" &&
        !state.busy &&
        !state.flow
      ) {
        void state.load();
      }
    });
    state.sync(context.gateway.snapshot);
    return () => {
      stop();
      stopEvents();
      state.dispose();
    };
  });
  return (
    <SettingsRow
      title={t("profilePage.discord.title")}
      description={
        <>
          <span>{t("profilePage.discord.description")}</span>
          <Show when={view().error}>
            {(error) => (
              <div class="callout danger" role="alert">
                {error()}{" "}
                <button class="btn btn--sm" onClick={() => void state.load()}>
                  {t("common.retry")}
                </button>
              </div>
            )}
          </Show>
          <Show
            when={
              !view().loading &&
              !view().selected?.available &&
              !view().selected?.senderIds.length &&
              !view().error
            }
          >
            <div>{t("profilePage.discord.unavailable")}</div>
          </Show>
        </>
      }
      control={
        <>
          <Show when={view().accounts.length > 1}>
            <select
              aria-label={t("profilePage.discord.gatewayAccount")}
              value={view().accountId}
              disabled={view().busy || Boolean(view().flow)}
              onChange={(event) => {
                state.accountId = event.currentTarget.value;
                state.publish();
              }}
            >
              <For each={view().accounts}>
                {(account) => <option value={account.accountId}>{account.accountId}</option>}
              </For>
            </select>
          </Show>
          <Show
            when={!view().loading}
            fallback={<SettingsStatus kind="muted" label={t("common.loading")} />}
          >
            <Show
              when={view().selected?.senderIds.length}
              fallback={
                <Show
                  when={view().flow}
                  fallback={
                    <button
                      class="btn btn--sm"
                      disabled={!view().available || !view().selected?.available || view().busy}
                      onClick={() => void state.connect()}
                    >
                      {t("profilePage.discord.connect")}
                    </button>
                  }
                >
                  {(flow) => (
                    <>
                      <SettingsStatus kind="muted" label={t("profilePage.discord.waiting")} />
                      <a href={flow().url} target="_blank" rel="noopener noreferrer">
                        {t("profilePage.discord.continue")}
                      </a>
                      <button
                        class="btn btn--sm"
                        disabled={view().busy}
                        onClick={() => void state.cancel()}
                      >
                        {t("common.cancel")}
                      </button>
                    </>
                  )}
                </Show>
              }
            >
              <SettingsValue value={view().selected?.senderIds.join(", ") ?? ""} />
              <SettingsStatus kind="ok" label={t("profilePage.discord.verified")} />
              <button
                class="btn btn--sm"
                disabled={!view().available || view().busy}
                onClick={() => void state.disconnect()}
              >
                {t("profilePage.discord.disconnect")}
              </button>
            </Show>
          </Show>
        </>
      }
    />
  );
}
