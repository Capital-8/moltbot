import { createSignal } from "solid-js";

type Highlighter = typeof import("./markdown-highlight-runtime.ts").highlightCodeHtml;
const [readHighlighter, setHighlighter] = createSignal<Highlighter | null | undefined>(undefined);
export { readHighlighter };
let highlighterLoad: Promise<void> | undefined;

/** Shared by code renderers; a failed optional chunk leaves escaped, copyable text. */
export function loadMarkdownHighlighter(): Promise<void> {
  return (highlighterLoad ??= importMarkdownHighlighter());
}

async function importMarkdownHighlighter(): Promise<void> {
  try {
    const { highlightCodeHtml } = await import("./markdown-highlight-runtime.ts");
    setHighlighter(() => highlightCodeHtml);
  } catch {
    setHighlighter(null);
    console.warn("[markdown] Syntax highlighting could not be loaded; showing plain code.");
  }
}

// Cached Markdown must subscribe even when a previous render already filled its cache.
export function markdownHighlightingReady(): boolean {
  return typeof readHighlighter() === "function";
}

export function markdownHighlightingPending(): boolean {
  return highlighterLoad !== undefined && readHighlighter() === undefined;
}
