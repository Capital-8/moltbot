import { asNullableRecord, readStringField } from "@openclaw/normalization-core/record-coerce";
import type { JSX } from "@solidjs/web";
import { createMemo, For, Show } from "solid-js";
import { ChannelIcon } from "../../components/solid/channel-icon.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { SettingsDisclosure } from "../../components/solid/settings-disclosure.tsx";
import { channelSnapshotEntryIsActive, resolveChannelAccounts } from "../../lib/channels/index.ts";
import { formatUiError, formatUiExternalText } from "../../lib/format-error.ts";
import "../../components/modal-dialog.tsx";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { ChannelSettingsSlot } from "./channel-settings-presentation.tsx";
import { channelDetailPresentations } from "./detail-presentation.ts";
import { channelDocsUrl } from "./hub-meta.ts";
import {
  ChannelConfig,
  ChannelConfigFeedback,
  channelConfigFormId,
  isSavingChannelConfig,
} from "./view.config.tsx";
import { renderChannelPairingDetail } from "./view.pairing.tsx";
import {
  booleanChannelFact,
  ChannelAccount,
  ChannelFacts,
  ChannelHealthStatus,
  channelLastActivity,
  channelProbe,
  resolveChannelDisplayState,
  resolveChannelHealth,
} from "./view.shared.tsx";
import type { ChannelsProps } from "./view.types.ts";

type ChannelDetailParams = { channelId: string; props: ChannelsProps };

/** The one line that answers "does it work", with the same words as the channel's list row. */
function ChannelDetailStatus(params: ChannelDetailParams) {
  const health = createMemo(() => resolveChannelHealth(params.channelId, params.props));
  const fact = createMemo(() => {
    if (health() === "attention" || health() === "notConfigured") {
      return null;
    }
    return channelProbe(params.channelId, params.props)?.ok === true
      ? t("common.probeOk")
      : channelLastActivity(params.channelId, params.props);
  });
  return (
    <div class="oc-dialog__description channels-detail__status">
      <span class="channels-detail__state">
        <ChannelHealthStatus health={health()} />
        <Show when={fact()}>{(text) => <span>{text()}</span>}</Show>
      </span>
      <a
        class="channels-wizard__link"
        href={channelDocsUrl(params.channelId)}
        target="_blank"
        rel="noreferrer noopener"
      >
        {t("channels.setup.viewDocs")}
      </a>
    </div>
  );
}

function channelIssues(params: ChannelDetailParams) {
  return (
    params.props.channels.channelsSnapshot?.statusIssues?.filter(
      (issue) => issue.channel === params.channelId,
    ) ?? []
  );
}

function channelLastError(params: ChannelDetailParams) {
  return readStringField(
    asNullableRecord(resolveChannelDisplayState(params.channelId, params.props).status),
    "lastError",
  );
}

function failedProbeDetail(params: ChannelDetailParams) {
  const probe = channelProbe(params.channelId, params.props);
  return probe?.ok === false
    ? formatUiExternalText([probe.status ?? "", probe.error ?? ""].filter(Boolean).join(" "))
    : null;
}

/**
 * Why it needs attention, once. An issue already says what to do, so the raw error
 * and the failed check behind it wait in Details.
 */
function ChannelProblem(params: ChannelDetailParams) {
  const owned = () => params.props.presentation.details.has(params.channelId);
  const issues = createMemo(() => channelIssues(params));
  const severalAccounts = () =>
    resolveChannelAccounts(
      params.props.channels.channelsSnapshot?.channelAccounts,
      params.channelId,
    ).length > 1;
  const fallback = createMemo(() => {
    if (owned() || issues().length > 0) {
      return null;
    }
    const lastError = channelLastError(params);
    if (lastError) {
      return { message: formatUiError(lastError) };
    }
    const detail = failedProbeDetail(params);
    return detail === null ? null : { title: t("common.probeFailed"), message: detail };
  });
  return (
    <Show
      when={issues().length > 0}
      fallback={
        <Show when={fallback()}>
          {(problem) => (
            <div class="callout danger">
              <Show when={problem().title}>
                <strong>{problem().title}</strong>
              </Show>
              <Show when={problem().message}>
                <div>{problem().message}</div>
              </Show>
            </div>
          )}
        </Show>
      }
    >
      <div class="callout danger" role="note">
        <For each={issues()}>
          {(issue) => (
            <div class="channels-detail__issue">
              <Show when={severalAccounts()}>
                <strong>{formatUiExternalText(issue.accountId)}</strong>
              </Show>
              <div>{formatUiExternalText(issue.message)}</div>
              {issue.fix ? <div>{formatUiExternalText(issue.fix)}</div> : undefined}
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}

function ChannelAccounts(params: ChannelDetailParams) {
  const presentation = () => channelDetailPresentations.get(params.channelId);
  const accounts = createMemo(() =>
    resolveChannelAccounts(
      params.props.channels.channelsSnapshot?.channelAccounts,
      params.channelId,
    ),
  );
  const shown = () => {
    const policy = presentation()?.accounts;
    return presentation()
      ? Boolean(policy && accounts().length >= policy.minimumCount)
      : accounts().length > 0;
  };
  return (
    <Show when={shown()}>
      <div class="settings-group">
        <For each={accounts()} keyed={(account) => account.accountId}>
          {(account) => {
            const username = () =>
              presentation()?.accounts?.titleSource === "botUsername"
                ? readStringField(
                    asNullableRecord(asNullableRecord(account().probe)?.bot),
                    "username",
                  )
                : undefined;
            return (
              <ChannelAccount
                title={username() ? `@${username()}` : account().name || account().accountId}
                account={account()}
              />
            );
          }}
        </For>
      </div>
    </Show>
  );
}

/** Facts for when something's off; a fact without a value isn't one. */
function ChannelDetailFacts(params: ChannelDetailParams) {
  const display = createMemo(() => resolveChannelDisplayState(params.channelId, params.props));
  const rows = createMemo(() => {
    const status = display().status;
    const text = (field: string) => readStringField(status, field);
    const time = (field: string) => {
      const value = status?.[field];
      return typeof value === "number" && value > 0 ? formatRelativeTimestamp(value) : undefined;
    };
    const audience = text("audienceType");
    const presentation = channelDetailPresentations.get(params.channelId);
    const extras = (presentation?.extraFacts ?? []).map((fact) => {
      switch (fact) {
        case "credential":
          return { label: t("common.credential"), value: text("credentialSource") };
        case "audience":
          return {
            label: t("common.audience"),
            value: audience
              ? `${audience}${text("audience") ? ` · ${text("audience")}` : ""}`
              : undefined,
          };
        case "baseUrl":
          return { label: t("common.baseUrl"), value: text("baseUrl") };
        case "mode":
          return { label: t("common.mode"), value: text("mode") };
      }
      throw new Error("Unknown bundled channel detail fact");
    });
    // Shown above when nothing better explains the failure; kept here when something does.
    const hasIssue = channelIssues(params).length > 0;
    const lastError = channelLastError(params);
    const failedProbe = failedProbeDetail(params);
    return [
      ...extras,
      { label: t("common.lastStart"), value: time("lastStartAt") },
      { label: t("common.lastProbe"), value: time("lastProbeAt") },
      {
        label: t("common.probeFailed"),
        value: hasIssue || lastError ? (failedProbe ?? undefined) : undefined,
      },
      {
        label: t("channels.lastError"),
        value: hasIssue && lastError ? formatUiError(lastError) : undefined,
      },
    ].filter((row): row is { label: string; value: string } => Boolean(row.value));
  });
  const connected = () => {
    const value = display().connected;
    return value !== null && !channelDetailPresentations.has(params.channelId)
      ? [booleanChannelFact("connected", value)]
      : [];
  };
  return (
    <Show when={rows().length + connected().length > 0}>
      <SettingsDisclosure title={t("channels.hub.details")}>
        <ChannelFacts rows={[...connected(), ...rows()]} />
      </SettingsDisclosure>
    </Show>
  );
}

/**
 * One slot, nothing moves: what you can do to the channel, until an edit is waiting,
 * and then only what you can do to the edit.
 */
function ChannelDetailFooter(params: ChannelDetailParams & { onSetup: () => void }) {
  const edits = () => params.props.configEdits[params.channelId];
  const saved = () => params.props.savedChannel === params.channelId;
  const saving = () => isSavingChannelConfig(params.channelId, params.props);
  const connected = () => params.props.channels.connected;
  // The same test that puts a channel under "Add a channel", whose row offers the same Set up.
  const notSetUp = () =>
    !channelSnapshotEntryIsActive(params.props.channels.channelsSnapshot, params.channelId);
  const checking = () => params.props.channels.channelsLoading;
  return (
    <openclaw-modal-actions class="oc-dialog__footer channels-detail__footer">
      <span class="channels-detail__save-status" role="status">
        {edits() ? t("channels.config.unsaved") : saved() ? t("configView.autoSaveSaved") : ""}
      </span>
      <Show
        when={edits()}
        fallback={
          <>
            <Show when={!notSetUp()}>
              <button
                type="button"
                class="btn channels-detail__check"
                disabled={!connected() || checking()}
                aria-busy={checking() ? "true" : "false"}
                onClick={() => params.props.onConfigReload(params.channelId)}
              >
                {t(checking() ? "common.refreshing" : "common.probe")}
              </button>
            </Show>
            <button
              type="button"
              class={["btn", { primary: notSetUp() }]}
              title={params.props.canAdmin ? "" : t("channels.hub.adminRequired")}
              disabled={!params.props.canAdmin || !connected()}
              onClick={() => params.onSetup()}
            >
              {t(notSetUp() ? "channels.hub.setUp" : "channels.hub.runSetup")}
            </button>
          </>
        }
      >
        <button
          type="button"
          class="btn"
          disabled={!connected() || saving()}
          onClick={() => params.props.onConfigReload(params.channelId)}
        >
          {t("channels.config.discard")}
        </button>
        <button
          class="btn primary"
          type="submit"
          form={channelConfigFormId(params.channelId)}
          disabled={!connected() || saving()}
        >
          {saving() ? t("common.saving") : t("common.save")}
        </button>
      </Show>
    </openclaw-modal-actions>
  );
}

export function renderChannelDetail(params: {
  channelId: string;
  label: string;
  pluginIconUrl?: string;
  props: ChannelsProps;
  onClose: () => void;
  onSetup: () => void;
}): JSX.Element {
  const owned = () => params.props.presentation.details.has(params.channelId);
  return (
    <openclaw-modal-dialog
      label={params.label}
      style={{ "--openclaw-modal-width": "640px" }}
      onModal-cancel={() => params.onClose()}
    >
      <div class="oc-dialog channels-detail">
        <div class="oc-dialog__header">
          <h2 class="oc-dialog__title">
            <ChannelIcon
              channelId={params.channelId}
              label={params.label}
              variant="picker"
              pluginIconUrl={params.pluginIconUrl}
            />
            {params.label}
          </h2>
          <button
            type="button"
            class="oc-dialog__close"
            aria-label={t("common.close")}
            onClick={() => params.onClose()}
          >
            <Icon name="x" />
          </button>
          <ChannelDetailStatus channelId={params.channelId} props={params.props} />
        </div>
        <div class="oc-dialog__body channels-detail__body">
          {params.props.wizardHost.blockedByDirtyConfig() &&
          (params.props.config.configFormDirty ||
            Object.keys(params.props.configEdits).length > 0) ? (
            <div class="callout warn">{t("channels.hub.saveBeforeSetup")}</div>
          ) : undefined}
          <ChannelProblem channelId={params.channelId} props={params.props} />
          {owned() ? (
            <ChannelSettingsSlot
              channelId={params.channelId}
              presentation={params.props.presentation.details}
            />
          ) : (
            <>
              <ChannelAccounts channelId={params.channelId} props={params.props} />
              <ChannelConfig channelId={params.channelId} props={params.props} />
            </>
          )}
          {renderChannelPairingDetail(params.channelId, params.props)}
          <Show when={!owned()}>
            <ChannelDetailFacts channelId={params.channelId} props={params.props} />
          </Show>
        </div>
        <ChannelConfigFeedback channelId={params.channelId} props={params.props} />
        <ChannelDetailFooter
          channelId={params.channelId}
          props={params.props}
          onSetup={() => params.onSetup()}
        />
      </div>
    </openclaw-modal-dialog>
  );
}
