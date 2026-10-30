import { defaultRangeExtractor, type Range, Virtualizer } from "@tanstack/virtual-core";
import { findMcpAppUnmountTargets } from "../../../components/mcp-app-unmount.ts";
import type { TranscriptInitialRange } from "./chat-transcript-initial-range.ts";
import type { TranscriptLayoutOwner } from "./chat-transcript-layout-owner.ts";
import type { TranscriptRenderSnapshot } from "./chat-transcript-session.ts";

export type TranscriptRangeOwner = {
  rowKeys: () => readonly string[];
  headerHeight: () => number;
  appliedHeaderHeight: () => number;
  focusedRowKey: () => string | null;
  initialRange: TranscriptInitialRange;
  prependAnchor: {
    extractRange(
      range: Range,
      indexes: ReadonlyMap<string, number>,
      focusedRowKey: string | null,
      messageRows?: ReadonlyMap<string, string>,
    ): number[];
  };
  layout: TranscriptLayoutOwner;
};

/** Keep header compensation atomic with the row-key anchor transition. */
export function setTranscriptRowRange(
  virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
  keys: readonly string[],
  rangeExtractor: (range: Range) => number[],
  headerDelta: number,
): void {
  virtualizer.setOptions({
    ...virtualizer.options,
    count: keys.length,
    getItemKey: (index) => keys[index]!,
    rangeExtractor,
    scrollMargin: virtualizer.options.scrollMargin + headerDelta,
  });
}

export function extractTranscriptRange(
  range: Range,
  rowIndexesByKey: ReadonlyMap<string, number>,
  retainedRowKeys: readonly (string | null)[],
): number[] {
  const indexes = defaultRangeExtractor(range);
  for (const key of retainedRowKeys) {
    const index = key === null ? undefined : rowIndexesByKey.get(key);
    if (index !== undefined && index >= 0 && index < range.count && !indexes.includes(index)) {
      indexes.push(index);
    }
  }
  return indexes.toSorted((left, right) => left - right);
}

export function previewTranscriptRowKeys(
  virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
  nextKeys: readonly string[],
  snapshot: Pick<
    TranscriptRenderSnapshot<unknown>,
    "rows" | "header" | "rowConfiguration" | "renderKeyRows"
  >,
  owner: TranscriptRangeOwner,
): Set<string> {
  const headerHeight = owner.headerHeight();
  if (
    nextKeys === owner.rowKeys() &&
    (snapshot.header?.height ?? 0) === headerHeight &&
    owner.layout.matchesRows(snapshot.rows, snapshot.rowConfiguration)
  ) {
    return new Set(virtualizer.getVirtualItems().map(({ index }) => nextKeys[index]!));
  }
  const nextIndexes = new Map(nextKeys.map((key, index) => [key, index]));
  const preview: Virtualizer<HTMLDivElement, HTMLElement> = new Virtualizer({
    ...virtualizer.options,
    initialMeasurementsCache: virtualizer.takeSnapshot(),
    initialOffset: virtualizer.scrollOffset ?? virtualizer.options.initialOffset,
    initialRect: virtualizer.scrollRect ?? virtualizer.options.initialRect,
    onChange: () => undefined,
    rangeExtractor: (range) =>
      owner.initialRange.preview(
        range,
        preview,
        (candidate) =>
          owner.prependAnchor.extractRange(
            candidate,
            nextIndexes,
            owner.focusedRowKey(),
            snapshot.renderKeyRows,
          ),
        (index) => owner.layout.previewRowMinimum(snapshot.rows[index]!, snapshot.rowConfiguration),
      ),
  });
  preview.scrollElement = virtualizer.scrollElement;
  // The fork uses the same placement and range owners without publishing candidate geometry.
  setTranscriptRowRange(
    preview,
    nextKeys,
    preview.options.rangeExtractor,
    (snapshot.header?.height ?? 0) - owner.appliedHeaderHeight(),
  );
  return new Set(preview.getVirtualIndexes().map((index) => nextKeys[index]!));
}

export function leavingTranscriptMcpAppRows(
  root: ParentNode | null,
  readRenderedKeys: () => ReadonlySet<string>,
): HTMLElement[] {
  const appRows = new Set(
    (root ? findMcpAppUnmountTargets([root]) : []).flatMap(
      (app) => app.closest<HTMLElement>(".chat-virtual-row") ?? [],
    ),
  );
  if (appRows.size === 0) {
    return [];
  }
  const renderedKeys = readRenderedKeys();
  return [...appRows].filter((row) => !renderedKeys.has(row.dataset.virtualRowKey ?? ""));
}

export function focusedTranscriptRowKey(
  scrollElement: HTMLElement | null,
  target: EventTarget | null,
): string | null {
  if (!(target instanceof Element) || !scrollElement?.contains(target)) {
    return null;
  }
  const row = target.closest<HTMLElement>(".chat-virtual-row[data-virtual-row-key]");
  return row && scrollElement.contains(row) ? row.dataset.virtualRowKey || null : null;
}
