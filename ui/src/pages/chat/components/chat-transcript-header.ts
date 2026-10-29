import type { Virtualizer } from "@tanstack/virtual-core";
import type { TranscriptInitialRange } from "./chat-transcript-initial-range.ts";

/** Compensate a header change when unchanged row keys do not trigger a prepend anchor. */
export function reconcileTranscriptHeaderMargin(
  virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
  headerHeight: number,
  appliedHeaderHeight: number,
): number {
  if (headerHeight === appliedHeaderHeight) {
    return appliedHeaderHeight;
  }
  const delta = headerHeight - appliedHeaderHeight;
  virtualizer.setOptions({
    ...virtualizer.options,
    scrollMargin: virtualizer.options.scrollMargin + delta,
  });
  const offset = virtualizer.scrollOffset;
  const next = offset === null ? null : Math.max(0, offset + delta);
  if (next !== null && next !== offset) {
    virtualizer.scrollOffset = next;
    virtualizer.scrollToOffset(next);
  }
  return headerHeight;
}

export function syncTranscriptRowsAndHeader(
  virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
  nextKeys: readonly string[],
  initialRange: TranscriptInitialRange,
  headerHeight: number,
  appliedHeaderHeight: number,
): number {
  // The header margin must land in the same setOptions as the key change:
  // exhausting history and removing its header is one edge-key adjustment.
  virtualizer.setOptions({
    ...virtualizer.options,
    count: nextKeys.length,
    getItemKey: (index) => nextKeys[index]!,
    rangeExtractor: (range) => initialRange.extract(range),
    scrollMargin: virtualizer.options.scrollMargin + headerHeight - appliedHeaderHeight,
  });
  return headerHeight;
}
