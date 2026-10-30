import {
  createMemo,
  createSignal,
  Errored,
  lazy,
  Loading,
  Show,
  type Element as SolidElement,
} from "solid-js";
import { resolveModelRuntimeRoute } from "../../../../../src/shared/model-runtime-route.js";
import { findOverlayParent } from "../../../components/overlay-lifecycle.ts";
import { hasProviderBrandIcon } from "../../../components/provider-icon-data.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { ProviderBrandIcon } from "../../../components/solid/provider-icon.tsx";
import "../../../components/tooltip.ts";
import { registerModelControlsEnglish } from "../../../i18n/locales/en-model-controls.ts";
import type { ChatModelCatalogState as ModelCatalogState } from "../../../lib/model-catalog-store.ts";
import type { ModelProviderAuthLabel } from "../../../lib/model-provider-auth-label.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import type { ChatContextWindowControlParams } from "./chat-context-window-control.tsx";
import type { ChatModelAccountSection } from "./chat-model-account-control.ts";
import { ChatModelCatalogRefresh, ChatModelCatalogState } from "./chat-model-catalog-state.tsx";
import {
  isModelPickerOptionSelected,
  type ChatModelPickerOption as ModelPickerOption,
  type ChatModelPickerTargetGroup,
} from "./chat-model-picker-options.ts";
import {
  ChatModelSearchContext,
  createChatModelSearch,
  handleModelPickerKeydown,
  handleModelSearchKeydown,
  resetModelSearch,
  updateModelSearch,
} from "./chat-model-picker-search.ts";
import { createChatPickerOverlay } from "./chat-picker-overlay.ts";

registerEnglishCatalog(registerModelControlsEnglish);

const ChatModelPickerPanel = lazy(() => import("./chat-model-picker-panel.tsx"), {
  export: "ChatModelPickerPanel",
});

export type ChatModelPickerParams = {
  providerAuth?: ReadonlyMap<string, ModelProviderAuthLabel>;
  accountSection?: ChatModelAccountSection;
  contextWindow?: ChatContextWindowControlParams;
  disabled: boolean;
  disabledReason?: string;
  modelCatalogState?: ModelCatalogState;
  /** Lets a lazy route wrap catalog status without adding its read to Chat boot. */
  renderModelCatalogStatus?: (render: () => SolidElement) => SolidElement;
  modelSelectionLocked: boolean;
  selectionScopeDescription?: string;
  modelOptions: ModelPickerOption[];
  open?: boolean;
  targetGroups?: readonly ChatModelPickerTargetGroup[];
  selectedModelValue: string;
  selectedAgentRuntime?: string;
  /** Pin recorded on the session row; only then does an unavailable Default row reset. */
  sessionModelPinned: boolean;
  sessionKey: string;
  triggerModelLabel: string;
  triggerModelValue?: string;
  triggerStatusLabel?: string;
  triggerLoading?: boolean;
  onModelSetup?: () => void;
  onProviderSettings?: (provider: string) => void;
  onOpen?: () => unknown;
  onOpenChange?: (open: boolean) => void;
  onModelSelect: (
    value: string,
    sessionKey: string,
    agentRuntime?: string | null,
  ) => Promise<unknown>;
  onTargetRetry?: (groupId: string) => unknown;
  onTargetSelect?: (groupId: string, value: string) => unknown;
};

export function ChatModelPicker(params: ChatModelPickerParams) {
  const search = createChatModelSearch();
  let summary: HTMLElement;
  let searchInput: HTMLInputElement | undefined;
  let details: HTMLDetailsElement | undefined;
  let pendingSearchFocus: Element | null | undefined;
  const focusSearch = () => {
    if (pendingSearchFocus === undefined || !details) {
      return;
    }
    if (
      !details.isConnected ||
      !details.open ||
      details.ownerDocument.activeElement !== pendingSearchFocus
    ) {
      pendingSearchFocus = undefined;
    } else if (searchInput?.isConnected) {
      pendingSearchFocus = undefined;
      searchInput.focus({ preventScroll: true });
    }
  };
  // Retain the panel after first use so search and provider expansion survive dismissal.
  const [choicesMounted, mountChoices] = createSignal(false);
  const prepareChoices = () => {
    if (!params.disabled && !details?.open) {
      // Activation intent evaluates the prefetched code; the open panel owns errors and retry.
      void ChatModelPickerPanel.preload().catch(() => undefined);
    }
  };
  const pickerOverlay = createChatPickerOverlay((target) => {
    search.setOpen(target.open);
    params.onOpenChange?.(target.open);
    if (!target.open) {
      pendingSearchFocus = undefined;
      params.accountSection?.onClose();
      resetModelSearch(target);
      return;
    }
    pendingSearchFocus = target.ownerDocument.activeElement;
    // The native surface is open; focus its retained input before result evaluation.
    focusSearch();
    mountChoices(true);
    void params.onOpen?.();
    requestAnimationFrame(focusSearch);
  });
  const hasChoices = () =>
    params.modelOptions.length > 0 ||
    (params.targetGroups?.length ?? 0) > 0 ||
    params.accountSection !== undefined;
  // Retain the route's catalog boundary without involving lazy result readiness.
  const renderDirect = (render: () => SolidElement) => render();
  const renderCatalogStatus = createMemo(() => params.renderModelCatalogStatus ?? renderDirect);
  const state = createMemo(() => {
    const activeModelOption = params.modelOptions.find((option) =>
      isModelPickerOptionSelected(option, params.selectedModelValue, params.selectedAgentRuntime),
    );
    const triggerModelValue = params.triggerModelValue;
    const triggerModelOption =
      triggerModelValue === undefined
        ? activeModelOption
        : triggerModelValue === ""
          ? undefined
          : params.modelOptions.find((option) =>
              isModelPickerOptionSelected(option, triggerModelValue, params.selectedAgentRuntime),
            );
    const modelToolsUnavailable = triggerModelOption?.supportsTools === false;
    const selectedContextWindowOption = params.contextWindow?.options.find(
      (option) => option.id === params.contextWindow?.selected,
    );
    const showContextWindowBadge =
      selectedContextWindowOption !== undefined &&
      params.contextWindow?.selected !== params.contextWindow?.defaultId;
    const triggerTitle = [
      params.triggerStatusLabel ?? params.triggerModelLabel,
      modelToolsUnavailable ? t("chat.modelControls.chatOnly") : "",
    ]
      .filter(Boolean)
      .join(" · ");
    return {
      triggerModelOption,
      modelToolsUnavailable,
      selectedContextWindowOption,
      showContextWindowBadge,
      triggerTitle,
    };
  });
  const closeModelPickerAfterSelection = (event: MouseEvent) => {
    // Option buttons live inside the picker overlay; its summary lives outside it.
    if (event.currentTarget instanceof Element) {
      findOverlayParent(event.currentTarget)?.request(false);
    }
    if (event.detail === 0) {
      summary.focus({ preventScroll: true });
    }
  };
  return (
    <ChatModelSearchContext value={search}>
      <details
        ref={(element) => {
          details = element;
          search.detailsRef(element);
          pickerOverlay.details(element);
        }}
        onClick={pickerOverlay.onClick}
        onToggle={pickerOverlay.onToggle}
        class="chat-controls__inline-select chat-controls__model-picker"
        data-chat-autotype-shortcuts
        prop:open={params.open === true}
        onKeyDown={handleModelPickerKeydown}
      >
        <summary
          ref={[(element) => (summary = element), search.summaryRef, pickerOverlay.trigger]}
          class={[
            "chat-controls__inline-select-trigger chat-controls__model-trigger",
            {
              "chat-controls__model-trigger--loading": params.triggerLoading,
            },
          ]}
          data-chat-model-select="true"
          data-chat-model-locked={params.modelSelectionLocked ? "true" : "false"}
          data-chat-select-value={params.selectedModelValue}
          data-chat-model-tools={state().modelToolsUnavailable ? "unavailable" : "available"}
          aria-label={`${t("chat.selectors.model")}: ${state().triggerTitle}${params.selectionScopeDescription ? `. ${params.selectionScopeDescription}` : ""}`}
          aria-busy={params.triggerLoading ? "true" : "false"}
          aria-disabled={params.disabled ? "true" : "false"}
          aria-description={params.disabledReason}
          title={params.disabledReason?.trim() || undefined}
          onPointerDown={(event) => {
            if (event.button === 0 && event.isPrimary && !event.defaultPrevented) {
              prepareChoices();
            }
          }}
          onKeyDown={(event) => {
            if (
              !event.defaultPrevented &&
              !event.isComposing &&
              event.keyCode !== 229 &&
              (event.key === "Enter" || event.key === " ")
            ) {
              prepareChoices();
            }
          }}
        >
          {state().modelToolsUnavailable ? (
            <openclaw-tooltip prop:content={t("chat.modelControls.chatOnlyHelp")}>
              <span class="chat-controls__model-capability-badge" aria-hidden="true">
                <Icon name="alertTriangle" />
                <span>{t("chat.modelControls.chatOnly")}</span>
              </span>
            </openclaw-tooltip>
          ) : undefined}
          {!params.triggerLoading &&
          !params.triggerStatusLabel &&
          state().triggerModelOption &&
          hasProviderBrandIcon(state().triggerModelOption!.provider) ? (
            <ProviderBrandIcon
              provider={state().triggerModelOption!.provider}
              class="chat-controls__trigger-provider-icon"
            />
          ) : undefined}
          <span class="chat-controls__inline-select-label">
            {params.triggerLoading ? (
              <span class="skeleton chat-controls__model-trigger-skeleton" aria-hidden="true" />
            ) : (
              (params.triggerStatusLabel ?? params.triggerModelLabel)
            )}
          </span>
          {state().showContextWindowBadge ? (
            <span
              class="chat-controls__locked-model-badge chat-controls__model-context-badge"
              data-chat-model-context-badge
            >
              {state().selectedContextWindowOption?.label}
            </span>
          ) : undefined}
          <span class="chat-controls__inline-select-chevron" aria-hidden="true">
            <Icon name="chevronUp" />
          </span>
        </summary>
        <div
          ref={pickerOverlay.surface}
          class="oc-overlay chat-picker-overlay"
          data-anchored-overlay
          popover="manual"
        >
          <div
            class="chat-controls__inline-select-menu chat-controls__model-menu"
            aria-label={t("chat.selectors.model")}
            data-chat-model-filtering={search.query().trim() ? "" : undefined}
          >
            {params.modelSelectionLocked ? (
              <div
                class="chat-controls__locked-model"
                aria-label={t("chat.selectors.modelLockedLabel")}
              >
                <span class="chat-controls__inline-select-section-label">
                  {t("chat.selectors.modelSection")}
                </span>
                <span class="chat-controls__locked-model-value">{params.triggerModelLabel}</span>
                <span class="chat-controls__locked-model-badge">
                  {t("chat.selectors.modelLocked")}
                </span>
              </div>
            ) : (
              <>
                {hasChoices() ? (
                  <div class="chat-controls__model-search-wrap">
                    <Icon name="search" />
                    <input
                      ref={[
                        search.inputRef(),
                        (element) => {
                          searchInput = element;
                          queueMicrotask(focusSearch);
                        },
                      ]}
                      class="chat-controls__model-search"
                      data-chat-model-search="true"
                      type="search"
                      role="combobox"
                      aria-autocomplete="list"
                      aria-controls={search.controls()}
                      aria-expanded={search.open() ? "true" : "false"}
                      aria-activedescendant={
                        search.highlighted() ? search.optionId(search.highlighted()!) : undefined
                      }
                      value={search.query()}
                      autocomplete="off"
                      spellcheck="false"
                      placeholder={t("chat.modelControls.searchModels")}
                      aria-label={t("chat.modelControls.searchModels")}
                      disabled={params.disabled}
                      onInput={(event) => updateModelSearch(event.currentTarget)}
                      onKeyDown={handleModelSearchKeydown}
                    />
                    {params.modelOptions.length > 0 ? (
                      <ChatModelCatalogRefresh state={params.modelCatalogState} />
                    ) : undefined}
                  </div>
                ) : undefined}
                {renderCatalogStatus()(() => (
                  <ChatModelCatalogState
                    state={params.modelCatalogState}
                    hasOptions={params.modelOptions.length > 0}
                    hasSelectableOptions={params.modelOptions.some((option) => !option.disabled)}
                    onModelSetup={params.onModelSetup}
                    emptyLabel={
                      params.modelOptions.some(
                        (option) =>
                          option.unavailableReason === "missing-auth" &&
                          resolveModelRuntimeRoute(option.provider, option.agentRuntimeId) ===
                            "claudeCli",
                      )
                        ? t("chat.modelControls.claudeCliNotReady")
                        : undefined
                    }
                  />
                ))}
              </>
            )}
            <Show when={choicesMounted()}>
              <Errored
                fallback={(_error, reset) => (
                  <div class="chat-controls__model-catalog-state" role="alert">
                    {t("chat.modelControls.modelsUnavailable")}
                    <button class="btn btn--sm" type="button" onClick={reset}>
                      {t("common.retry")}
                    </button>
                  </div>
                )}
              >
                <Loading
                  fallback={
                    <div class="chat-controls__model-catalog-state" role="status">
                      {t("chat.modelControls.loadingModels")}
                    </div>
                  }
                >
                  <ChatModelPickerPanel
                    params={params}
                    onSelectionClose={closeModelPickerAfterSelection}
                  />
                </Loading>
              </Errored>
            </Show>
            {params.modelCatalogState?.modelSelectionPolicy?.restricted ? (
              <div class="chat-controls__model-catalog-state" data-chat-model-policy>
                {t("chat.modelControls.restrictedModelsHelp")}
              </div>
            ) : undefined}
          </div>
        </div>
      </details>
    </ChatModelSearchContext>
  );
}
