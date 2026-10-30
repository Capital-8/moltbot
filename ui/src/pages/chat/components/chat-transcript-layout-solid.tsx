import { dynamic, render, type JSX } from "@solidjs/web";
import { createMemo, createSignal, For, onSettled, runWithOwner, Show, useContext } from "solid-js";
import type { MarkdownPrewarmMode } from "../../../components/markdown.ts";
import { PRESENTATION_CHANGED_EVENT, type PresentationBinding } from "../../../lib/presentation.ts";
import { ApplicationProvider } from "../../../lib/reactive/context.ts";
import { elementRef } from "../../../lib/reactive/element-ref.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import { projectOwner } from "../../../lib/reactive/projection.ts";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";
import type { AfterCommitEffect } from "../render-lifecycle.ts";
import {
  createSolidRenderLifecycle,
  type SolidRenderLifecycle,
} from "../solid-render-lifecycle.ts";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";
import type { GroupedMessageOptions } from "./chat-message-bubble-options.ts";
import { prewarmGroupedMessage } from "./chat-message-bubble-presentation.ts";
import {
  TranscriptRowKeyContext,
  type TranscriptContent,
  type TranscriptLayoutProps,
  type TranscriptRow,
} from "./chat-transcript-layout.ts";
import { TranscriptMediaDisconnect } from "./chat-transcript-media-lifecycle.ts";
import { transcriptArraysEqual } from "./chat-transcript-memo.ts";
import { TranscriptMessageElementsContext } from "./chat-transcript-message-elements.ts";
import { GuardedTranscriptItem } from "./chat-transcript-render-guard.ts";
import { nativeRows, type NativeTranscriptView } from "./chat-transcript-rows.ts";

function NativeRow(props: { value: NativeTranscriptView }): JSX.Element {
  const Row = dynamic(() => nativeRows[props.value.kind]);
  return (
    <Show
      when={props.value.kind === "group"}
      fallback={
        <ChatLazyBoundary
          fallback={
            <div class="chat-group" role="status">
              {t("common.loading")}
            </div>
          }
        >
          <Row {...props.value} />
        </ChatLazyBoundary>
      }
    >
      <Row {...props.value} />
    </Show>
  );
}

function RowContent(props: { value: TranscriptContent }): JSX.Element {
  // Cut off unchanged rows before the content-kind branch and its child bindings.
  const current = createMemo(() => props.value, {
    equals: (before, next) =>
      before instanceof GuardedTranscriptItem && next instanceof GuardedTranscriptItem
        ? transcriptArraysEqual(before.dependencies, next.dependencies)
        : Object.is(before, next),
  });
  const native = () => {
    const value = current();
    return value instanceof GuardedTranscriptItem ? value.native : undefined;
  };
  const fallback = () => {
    const value = current();
    return value instanceof GuardedTranscriptItem ? null : value;
  };
  return (
    <Show when={native()} fallback={fallback()}>
      {(view) => <NativeRow value={view()} />}
    </Show>
  );
}

function TranscriptRows(props: {
  snapshot: TranscriptLayoutProps;
  measureRowRefFor: TranscriptLayoutProps["measureRowRefFor"];
  columnRef: (element: HTMLDivElement) => void;
}) {
  const presented = useContext(ContentPresentation);
  const virtualRows = createMemo(() => {
    return props.snapshot.virtualizer.getVirtualItems();
  });
  const getContent = createMemo(() => props.snapshot.getContent);
  const activeRows = createMemo(() =>
    virtualRows().filter((row) => props.snapshot.activeRowKeys.has(String(row.key))),
  );
  const blockStart = () =>
    activeRows()[0]?.start ?? props.snapshot.virtualizer.options.scrollMargin;
  const gaps = createMemo(
    () =>
      new Map(
        activeRows().map((row, index, rows) => {
          const previous = rows[index - 1];
          return [
            row.key,
            previous && row.index > previous.index + 1 ? row.start - previous.end : 0,
          ];
        }),
      ),
  );
  const rowRef = (key: string) => {
    const measureRef = props.measureRowRefFor(key);
    return elementRef((element: HTMLDivElement) => {
      measureRef(element);
      return () => measureRef(undefined);
    });
  };
  return (
    <>
      {/* Live controls can retire before a gesture releases the accepted row model. */}
      <div style={{ height: `${props.snapshot.headerHeight}px`, "transition-property": "none" }}>
        {props.snapshot.header}
      </div>
      <div class="chat-virtual-sizer" ref={(element) => props.columnRef(element)}>
        {props.snapshot.overlay}
        <div
          class="chat-virtual-block"
          style={{
            // WebKit 26.4 omits ancestor transforms from top-layer CSS anchor coordinates.
            top: `${blockStart() - props.snapshot.virtualizer.options.scrollMargin}px`,
          }}
        >
          <For each={virtualRows()} keyed={(row) => row.key}>
            {(virtualRow) => {
              const index = createMemo(() => virtualRow().index);
              const row = createMemo(() => props.snapshot.rows[index()]);
              const content = createMemo(() => {
                // Content rows may replace their DOM without replacing the row model.
                const source = row()?.kind === "content" ? props.snapshot.getContent : getContent();
                return source(index());
              });
              const active = createMemo(() => props.snapshot.activeRowKeys.has(row()?.key ?? ""));
              const preparing = createMemo(() => row()?.key === props.snapshot.preparingRowKey);
              const gap = () => gaps().get(virtualRow().key) ?? 0;
              return (
                <>
                  <Show when={gap() > 0}>
                    <div aria-hidden="true" style={{ height: `${gap()}px` }} />
                  </Show>
                  <div
                    ref={[rowRef(String(virtualRow().key))]}
                    class={[
                      "chat-virtual-row",
                      { "chat-virtual-row--first": virtualRow().index === 0 },
                    ]}
                    style={{
                      "contain-intrinsic-block-size": `${virtualRow().size}px`,
                      "min-height": `${props.snapshot.layout.rowMinimum(index())}px`,
                    }}
                    data-index={String(virtualRow().index)}
                    data-virtual-row-key={row()?.key}
                    data-prepared-row={active() ? undefined : "true"}
                    data-preparing-row={preparing() ? "true" : undefined}
                    inert={!active()}
                    aria-hidden={active() ? undefined : "true"}
                  >
                    <TranscriptRowKeyContext value={() => row()?.key}>
                      <ContentPresentation value={() => presented() && (active() || preparing())}>
                        <RowContent value={content()} />
                      </ContentPresentation>
                    </TranscriptRowKeyContext>
                  </div>
                </>
              );
            }}
          </For>
        </div>
      </div>
    </>
  );
}

/** One Solid root per session, independent of the caller's render computation. */
export class ChatTranscriptRenderer {
  private contentSource?: {
    rows: readonly TranscriptRow[];
    renderer: unknown;
    getContent: (index: number) => TranscriptContent;
  };
  private prewarming = new WeakMap<TranscriptRow, { mode: MarkdownPrewarmMode; next: number }>();
  private element?: HTMLDivElement;
  private column?: HTMLDivElement;
  private accepted?: TranscriptLayoutProps;
  private committed?: TranscriptLayoutProps;
  private lifecycle?: SolidRenderLifecycle<TranscriptLayoutProps>;
  private publishPresentation?: () => void;
  private disposeRoot?: () => void;
  private binding?: PresentationBinding;
  private stopPresentation?: () => void;
  private commitQueued = false;
  private readonly layoutEffects = new Set<() => void>();
  private readonly mediaDisconnect = new Set<() => void>();
  private publish?: () => void;
  private readonly presentationChanged = () => this.publishPresentation?.();

  contentFor<T>(
    rows: readonly TranscriptRow<T>[],
    renderer: (row: TranscriptRow<T>) => TranscriptContent,
  ) {
    // Geometry commits reuse content; a replaced row or renderer still refreshes it.
    if (this.contentSource?.rows !== rows || this.contentSource.renderer !== renderer) {
      this.prewarming = new WeakMap();
      this.contentSource = { rows, renderer, getContent: (index) => renderer(rows[index]!) };
    }
    return this.contentSource.getContent;
  }

  prewarmRow(index: number, mode: MarkdownPrewarmMode = "cold-fragment"): boolean {
    const row = this.contentSource?.rows[index];
    if (!row) {
      return false;
    }
    let progress = this.prewarming.get(row);
    if (!progress || progress.mode !== mode) {
      progress = { mode, next: 0 };
      this.prewarming.set(row, progress);
    }
    const content = this.contentSource?.getContent(index);
    const view = content instanceof GuardedTranscriptItem ? content.native : undefined;
    // Restoring every source in an atomic row larger than the fragment cache
    // would evict its own earlier work forever. Restore a bounded prefix of
    // eight sources; the shared cache still caps all rows at 32 fragments.
    let position = 0;
    const prewarm = (
      message: unknown,
      options: Pick<GroupedMessageOptions, "onOpenImage" | "fetchLinkFavicon">,
    ) => {
      const currentMode = mode === "fragment" && position >= 8 ? "cold-fragment" : mode;
      if (position++ < progress.next) {
        return false;
      }
      // Finish this pass even if a large row evicts its earlier HTML entries.
      progress.next = position;
      return prewarmGroupedMessage(message, options, currentMode);
    };
    if (view?.kind === "group" && !view.group.isStreaming) {
      for (const message of view.group.messages) {
        if (prewarm(message.message, view.options)) {
          return true;
        }
      }
    } else if (view?.kind === "frame" && view.frame.outcome.kind === "completed") {
      // Only this fragment's visible groups participate; collapsed work stays cold.
      // Admit one message per callback so a whole run cannot consume the slice.
      for (const part of view.frame.parts) {
        if (part.kind !== "group" || part.isStreaming) {
          continue;
        }
        const options = view.options.renderGroupOptions(part);
        for (const message of part.messages) {
          if (prewarm(message.message, options)) {
            return true;
          }
        }
      }
    }
    this.prewarming.delete(row);
    return false;
  }

  get columnElement(): HTMLDivElement | undefined {
    return this.column;
  }

  coversViewport(range: { startIndex: number; endIndex: number } | null): boolean {
    const snapshot = this.committed;
    if (!range || !snapshot) {
      return false;
    }
    for (let index = range.startIndex; index <= range.endIndex; index++) {
      const row = snapshot.rows[index];
      if (!row || !snapshot.activeRowKeys.has(row.key)) {
        return false;
      }
    }
    return true;
  }

  subscribe(listener: () => void): () => void {
    this.publish = listener;
    return () => {
      this.publish = undefined;
    };
  }

  isPresented(): boolean {
    const presented = this.accepted?.presented ?? false;
    return (
      this.element?.isConnected === true &&
      (typeof presented === "boolean" ? presented : presented.isPresented())
    );
  }

  connect(): void {
    this.publishPresentation?.();
  }

  disconnect(isConnected: () => boolean): void {
    for (const retire of this.mediaDisconnect) {
      retire();
    }
    // Moving a retained pane disconnects and reconnects within one task.
    queueMicrotask(() => {
      if (!isConnected()) {
        this.dispose();
      }
    });
  }

  afterCommit(effect: AfterCommitEffect, onCancel?: () => void): () => void {
    if (!this.lifecycle) {
      onCancel?.();
      return () => {};
    }
    return this.lifecycle.afterCommit(effect, onCancel);
  }

  syncInitialPosition(): void {
    if (this.element && this.accepted) {
      this.element.style.visibility = this.accepted.initialPositionPending() ? "hidden" : "";
    }
  }

  queueAfterCommit(effect: () => void): void {
    if (!this.lifecycle || this.layoutEffects.has(effect)) {
      return;
    }
    this.layoutEffects.add(effect);
    const release = () => {
      this.layoutEffects.delete(effect);
    };
    this.lifecycle.afterCommit(() => {
      // Nested row islands finish their commits before initial geometry is read.
      queueMicrotask(() => {
        release();
        if (this.isPresented()) {
          effect();
        }
      });
    }, release);
  }

  commit(): void {
    if (!this.lifecycle || this.commitQueued || this.accepted === this.committed) {
      return;
    }
    this.commitQueued = true;
    this.lifecycle.afterCommit(
      () => {
        this.commitQueued = false;
        const current = this.lifecycle?.snapshot();
        if (!current || !this.element) {
          return;
        }
        this.committed = current;
        // Keep layout measurable, but do not paint the initial estimated range
        // before the session owner has placed it at the correct reading edge.
        this.syncInitialPosition();
        this.element.toggleAttribute("data-measuring-rows", current.measureRows);
        current.layout.commitRange(
          this.element,
          current.virtualizer.getTotalSize() + current.headerHeight,
        );
        current.onCommit();
      },
      () => {
        this.commitQueued = false;
      },
    );
  }

  render(next: TranscriptLayoutProps): HTMLDivElement {
    this.accepted = next;
    const binding = typeof next.presented === "boolean" ? undefined : next.presented;
    if (binding?.owner !== this.binding?.owner) {
      this.stopPresentation?.();
      this.stopPresentation = binding
        ? listen(binding.owner, PRESENTATION_CHANGED_EVENT, this.presentationChanged)
        : undefined;
    }
    this.binding = binding;
    if (!this.element) {
      const element = document.createElement("div");
      element.className = "chat-thread-inner chat-thread-inner--virtual";
      element.style.visibility = next.initialPositionPending() ? "hidden" : "";
      this.element = element;
      // This retained transcript island outlives the computation that introduces its DOM.
      // Its session owner disposes the detached root, including while the pane is parked.
      this.disposeRoot = runWithOwner(null, () =>
        render(() => {
          const [presented, setPresented] = createSignal(this.isPresented(), { ownedWrite: true });
          this.publishPresentation = () => setPresented(this.isPresented());
          const active = () => presented() && this.isPresented();
          const source = projectOwner(this, (owner) => {
            if (!owner.accepted) {
              throw new Error("Transcript render snapshot was read after disposal");
            }
            return owner.accepted;
          });
          const lifecycle = createSolidRenderLifecycle({
            host: this,
            // The plain owner state also fences callbacks before the signal flushes.
            presented: active,
            read: source.read,
          });
          this.lifecycle = lifecycle;
          const snapshot = createMemo(lifecycle.snapshot);
          const capture = (event: Event) => snapshot().captureInteractionResize(event);
          onSettled(() => listen(element, "click", capture, true));
          const content = () => (
            <TranscriptMessageElementsContext value={next.messageElements}>
              <TranscriptMediaDisconnect value={this.mediaDisconnect}>
                <ContentPresentation value={active}>
                  <TranscriptRows
                    snapshot={snapshot()}
                    measureRowRefFor={next.measureRowRefFor}
                    columnRef={(column) => {
                      this.column = column;
                    }}
                  />
                </ContentPresentation>
              </TranscriptMediaDisconnect>
            </TranscriptMessageElementsContext>
          );
          // Keep the session root independent while retaining its application capabilities.
          return (
            <Show when={snapshot().applicationContext} fallback={content()} keyed>
              {(application) => (
                <ApplicationProvider value={application}>{content()}</ApplicationProvider>
              )}
            </Show>
          );
        }, element),
      );
    } else {
      // Read the native offset before row mutations dirty layout. The later
      // commit still accepts any sizes discovered while mounting those rows.
      next.layout.commitRange(this.element, next.virtualizer.getTotalSize() + next.headerHeight);
      this.publishPresentation?.();
      this.publish?.();
    }
    this.commit();
    next.scrollElementRef(this.element);
    return this.element;
  }

  dispose(): void {
    this.stopPresentation?.();
    this.stopPresentation = undefined;
    this.binding = undefined;
    this.disposeRoot?.();
    this.disposeRoot = undefined;
    this.publishPresentation = undefined;
    this.lifecycle = undefined;
    this.accepted = undefined;
    this.contentSource = undefined;
    this.prewarming = new WeakMap();
    this.committed = undefined;
    this.commitQueued = false;
    this.layoutEffects.clear();
    this.element = undefined;
    this.column = undefined;
  }
}
