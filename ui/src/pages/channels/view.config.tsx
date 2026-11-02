import { createMemo, For, Show } from "solid-js";
import { analyzeConfigSchema } from "../../components/config-form.analyze.ts";
import { ConfigNode } from "../../components/config-form.node.tsx";
import { ConfigTierGroups } from "../../components/config-form.render.tsx";
import { schemaType, type JsonSchema } from "../../components/config-form.shared.ts";
import { SettingsLoadingSkeleton } from "../../components/solid/settings-ui.tsx";
import { formatChannelExtraValue, resolveChannelConfigValue } from "../../lib/channels/index.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { applyChannelConfigEdits } from "./channel-config-draft.ts";
import type { ChannelsProps } from "./view.types.ts";

function resolveSchemaNode(schema: JsonSchema | null, path: string[]): JsonSchema | null {
  let current = schema;
  for (const key of path) {
    if (!current || schemaType(current) !== "object") {
      return null;
    }
    const additional = current.additionalProperties;
    current =
      current.properties?.[key] ||
      (additional && typeof additional === "object" ? additional : null);
  }
  return current;
}

const EXTRA_CHANNEL_FIELDS = ["groupPolicy", "streamMode", "dmPolicy"] as const;

export const channelConfigFormId = (channelId: string) => `channel-config-${channelId}`;

export function isSavingChannelConfig(channelId: string, props: ChannelsProps) {
  return (
    props.savingChannel === channelId || props.mutationBusy?.config || props.config.configSaving
  );
}

/** Outside the form's scroll, so what happened to a save never depends on scrolling to it. */
export function ChannelConfigFeedback(params: { channelId: string; props: ChannelsProps }) {
  const failure = () => params.props.config.lastError ?? params.props.channels.channelsError;
  return (
    <Show when={failure() || params.props.saveConflict === params.channelId}>
      <div class="channels-detail__feedback" role="alert">
        <div class={failure() ? "callout danger" : "callout warn"}>
          {failure() ?? t("channels.config.conflictKept")}
        </div>
      </div>
    </Show>
  );
}

export function ChannelConfig(params: { channelId: string; props: ChannelsProps }) {
  const analysis = createMemo(() => analyzeConfigSchema(params.props.config.configSchema));
  const node = createMemo(() =>
    resolveSchemaNode(analysis().schema, ["channels", params.channelId]),
  );
  const edits = () => params.props.configEdits[params.channelId];
  const value = createMemo(() =>
    applyChannelConfigEdits(
      resolveChannelConfigValue(params.props.config.configForm ?? {}, params.channelId),
      params.channelId,
      edits() ?? [],
    ),
  );
  // A field the form already edits isn't worth repeating as text below it.
  const extraFields = () =>
    EXTRA_CHANNEL_FIELDS.filter((field) => field in value() && !node()?.properties?.[field]);
  const unsupported = createMemo(() => new Set(analysis().unsupportedPaths));
  const saving = () =>
    params.props.savingChannel === params.channelId ||
    params.props.mutationBusy?.config ||
    params.props.config.configSaving;
  const disabled = createMemo(() => saving() || params.props.config.configSchemaLoading);
  return (
    <Show
      when={!params.props.config.configSchemaLoading}
      fallback={<SettingsLoadingSkeleton label={t("channels.config.loadingSchema")} rows={2} />}
    >
      <form
        id={channelConfigFormId(params.channelId)}
        class="channels-detail__form"
        novalidate
        onSubmit={(event) => {
          event.preventDefault();
          if (event.currentTarget.reportValidity()) {
            params.props.onConfigSave(params.channelId);
          }
        }}
      >
        <Show
          when={node()}
          fallback={
            <div class="settings-row__desc">
              {t(
                analysis().schema
                  ? "channels.config.channelSchemaUnavailable"
                  : "channels.config.schemaUnavailable",
              )}
            </div>
          }
        >
          {(schema) => (
            <>
              <div class="config-form">
                <ConfigTierGroups
                  schema={schema()}
                  path={["channels", params.channelId]}
                  hints={params.props.config.configUiHints}
                  revealAdvanced={params.props.showAdvancedSettings}
                  onShowAdvanced={() => params.props.onShowAdvancedSettings(true)}
                  onHideAdvanced={() => params.props.onShowAdvancedSettings(false)}
                  renderTier={(tier) => (
                    <ConfigNode
                      params={{
                        schema: tier(),
                        value: value(),
                        path: ["channels", params.channelId],
                        hints: params.props.config.configUiHints,
                        unsupported: unsupported(),
                        disabled: disabled(),
                        showLabel: false,
                        maskSensitive: true,
                        onPatch: (path, next) =>
                          params.props.onConfigPatch(params.channelId, path, next),
                      }}
                    />
                  )}
                />
              </div>
              <Show when={extraFields().length > 0}>
                <div>
                  <For each={extraFields()}>
                    {(field) => (
                      <div class="settings-row__desc">
                        {field}: {formatChannelExtraValue(value()[field])}
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </>
          )}
        </Show>
      </form>
    </Show>
  );
}
