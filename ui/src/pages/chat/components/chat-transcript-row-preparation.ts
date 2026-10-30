import { createMcpAppUnmountGate } from "../../../components/mcp-app-unmount.ts";
import { chatRichPresentation } from "./chat-rich-presentation.ts";
import type { ChatTranscriptRenderer } from "./chat-transcript-layout-solid.tsx";
import type {
  RichPresentationPreparation,
  TranscriptLayoutProps,
} from "./chat-transcript-layout.ts";
import {
  leavingTranscriptMcpAppRows,
  previewTranscriptRowKeys,
  type TranscriptRangeOwner,
} from "./chat-transcript-range.ts";
import type { TranscriptRenderSnapshot } from "./chat-transcript-session.ts";

type RowPreparationHost = Pick<
  TranscriptLayoutProps,
  | "messageElements"
  | "layout"
  | "virtualizer"
  | "scrollElementRef"
  | "captureInteractionResize"
  | "measureRowRefFor"
> &
  TranscriptRangeOwner & {
    renderer: ChatTranscriptRenderer;
    invalidate: () => void;
    element: () => HTMLDivElement | null;
  };

/** Admit rich readers and retire foreign views before the session commits its row model. */
export class TranscriptRowPreparation {
  private rich: { view: RichPresentationPreparation } | undefined;
  private readonly unmountGate;

  constructor(private readonly host: RowPreparationHost) {
    this.unmountGate = createMcpAppUnmountGate<HTMLDivElement>(host.invalidate);
  }

  clear(): void {
    this.rich = undefined;
  }

  render<T>(
    snapshot: TranscriptRenderSnapshot<T>,
    commit: (rowModelChanged: boolean, nextKeys: readonly string[]) => HTMLDivElement,
  ): HTMLDivElement {
    const host = this.host;
    const rows = snapshot.rows;
    const rowKeys = host.rowKeys();
    const rowModelChanged =
      rows.length !== rowKeys.length || rows.some((row, index) => row.key !== rowKeys[index]);
    const nextKeys = rowModelChanged ? rows.map((row) => row.key) : rowKeys;
    let candidateKeys: Set<string> | undefined;
    const preview = () =>
      (candidateKeys ??= previewTranscriptRowKeys(host.virtualizer, nextKeys, snapshot, host));
    if (!chatRichPresentation.ready() && snapshot.richRowKeys?.size) {
      const required = [...preview()].some((key) => snapshot.richRowKeys!.has(key));
      // Warm only the estimated initial viewport, while the exact range still
      // owns admission. A tall tail row may make some of this work unnecessary.
      const warmInitialWindow =
        !this.rich &&
        !required &&
        rowModelChanged &&
        host.initialRange.pending &&
        [...previewTranscriptRowKeys(host.virtualizer, nextKeys, snapshot, host, true)].some(
          (key) => snapshot.richRowKeys!.has(key),
        );
      if (!this.rich && (required || warmInitialWindow)) {
        const pending: { view: RichPresentationPreparation } = { view: { status: "loading" } };
        this.rich = pending;
        void chatRichPresentation.load().then(
          () => {
            if (this.rich === pending) {
              this.rich = undefined;
              host.invalidate();
            }
          },
          (error: unknown) => {
            if (this.rich === pending) {
              pending.view = { status: "error", error };
              host.invalidate();
            }
          },
        );
      }
      if (required && this.rich) {
        return host.renderer.holdRichPreparation(this.rich.view, {
          applicationContext: snapshot.applicationContext,
          messageElements: host.messageElements,
          layout: host.layout,
          headerHeight: 0,
          presented: snapshot.presented,
          initialPositionPending: () => true,
          onCommit: () => {},
          rows: [],
          getContent: () => null,
          virtualizer: host.virtualizer,
          overlay: null,
          header: null,
          scrollElementRef: host.scrollElementRef,
          captureInteractionResize: host.captureInteractionResize,
          measureRowRefFor: host.measureRowRefFor,
          measureRows: false,
        });
      }
    }
    if (chatRichPresentation.ready()) {
      this.rich = undefined;
    }
    const nextRowKeys = rowModelChanged
      ? nextKeys
      : host.virtualizer.getVirtualItems().map(({ index }) => rows[index]!.key);
    return this.unmountGate.render(
      rowModelChanged ? nextKeys : JSON.stringify(nextRowKeys),
      () => commit(rowModelChanged, nextKeys),
      () =>
        leavingTranscriptMcpAppRows(host.element(), () =>
          rowModelChanged ? preview() : new Set(nextRowKeys),
        ),
      { afterCommit: (effect) => void host.renderer.afterCommit(effect) },
    );
  }
}
