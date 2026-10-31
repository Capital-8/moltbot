import {
  isCodeHighlightClass,
  type CapturedCodeRows,
  type ChatRowDisplay,
  type CodeHighlightOffsets,
} from "../lib/chat/row-display-facts.ts";
import { fnv1aUtf16 } from "../lib/fnv1a.ts";
import { CODE_PREVIEW_LINE_COUNT } from "./markdown-code-highlight-chunks.ts";

const displays = new WeakMap<HTMLElement, { display: ChatRowDisplay; key: string }>();
const rows = new WeakMap<HTMLElement, { codes: Set<HTMLElement>; changed?: () => void }>();

/** Only decoration is cached; the row's current plain text always owns its contents. */
export function restoreMarkdownCodeDisplay(code: HTMLElement, display: ChatRowDisplay): void {
  const source = code.textContent ?? "";
  const language =
    code.getAttribute("data-code-highlight") ??
    [...code.classList].find((value) => value.startsWith("language-"))?.slice(9) ??
    "";
  // A hash collision can only reuse coloring, never replace the current source text.
  const key = fnv1aUtf16(JSON.stringify(["hljs-11.12:v2", language, source])).toString(36);
  displays.set(code, { display, key });
  if (code.classList.contains("hljs")) {
    return;
  }
  const current = display.read();
  const saved = current?.facts?.code?.[key];
  if (!saved || saved.end > source.length || !current?.codeClasses) {
    return;
  }
  const fragment = document.createDocumentFragment();
  const parents: Array<{ node: ParentNode; end: number }> = [{ node: fragment, end: saved.end }];
  let offset = 0;
  const close = () => {
    const parent = parents.pop()!;
    parent.node.append(document.createTextNode(source.slice(offset, parent.end)));
    offset = parent.end;
  };
  for (let index = 0; index < saved.runs.length; index += 3) {
    const start = saved.runs[index]!;
    const end = start + saved.runs[index + 1]!;
    const className = current.codeClasses[saved.runs[index + 2]!];
    while (parents.length > 1 && parents.at(-1)!.end <= start) {
      close();
    }
    const parent = parents.at(-1)!;
    if (start < offset || end > parent.end || !className || !isCodeHighlightClass(className)) {
      return;
    }
    parent.node.append(document.createTextNode(source.slice(offset, start)));
    const span = document.createElement("span");
    span.className = className;
    parent.node.append(span);
    parents.push({ node: span, end });
    offset = start;
  }
  while (parents.length) {
    close();
  }
  code.replaceChildren(fragment, document.createTextNode(source.slice(saved.end)));
  code.classList.add("hljs");
}

/** Existing block scans bind native nodes after their Markdown fragment is adopted. */
export function trackMarkdownCodeDisplay(code: HTMLElement): void {
  if (!displays.has(code)) {
    return;
  }
  const row = code.closest<HTMLElement>(".chat-virtual-row");
  if (!row) {
    return;
  }
  const current = rows.get(row) ?? { codes: new Set<HTMLElement>() };
  current.codes.add(code);
  rows.set(row, current);
  current.changed?.();
}

function captureCode(code: HTMLElement, lines: number) {
  const source = code.textContent ?? "";
  let end = 0;
  for (let line = 0; line < lines && end < source.length; line++) {
    const newline = source.indexOf("\n", end);
    end = newline < 0 ? source.length : newline + 1;
  }
  if (!end || end > 50_000) {
    return undefined;
  }
  const classes: string[] = [];
  const runs: number[] = [];
  let offset = 0;
  let valid = true;
  const walk = (node: Node) => {
    if (node instanceof Text) {
      offset += node.length;
      return;
    }
    let slot: number | undefined;
    if (node instanceof HTMLElement && node.localName === "span" && offset < end) {
      const name = node.className;
      if (!isCodeHighlightClass(name) || runs.length >= 384) {
        valid = false;
        return;
      }
      let classIndex = classes.indexOf(name);
      if (classIndex < 0) {
        classIndex = classes.length;
        classes.push(name);
      }
      slot = runs.length;
      runs.push(offset, 0, classIndex);
    }
    for (const child of node.childNodes) {
      if (offset >= end || !valid) {
        break;
      }
      walk(child);
    }
    if (slot !== undefined) {
      runs[slot + 1] = Math.min(offset, end) - runs[slot]!;
    }
  };
  walk(code);
  return valid && runs.length && classes.length <= 32
    ? { classes, offsets: { end, runs } satisfies CodeHighlightOffsets }
    : undefined;
}

/** Reuse the row-layout capture's measured range; never observe or retain offscreen history. */
export function captureMarkdownCodeRows(
  items: Iterable<{ element: HTMLElement; start: number; end: number }>,
  viewport: { top: number; height: number; offset: number },
  changed: () => void,
): CapturedCodeRows {
  const captured: CapturedCodeRows = { classes: [], rows: {} };
  for (const item of items) {
    const current = rows.get(item.element) ?? { codes: new Set<HTMLElement>() };
    rows.set(item.element, current);
    current.changed = changed;
    if (item.end <= viewport.offset || item.start >= viewport.offset + viewport.height * 2) {
      continue;
    }
    for (const code of current.codes) {
      if (!item.element.contains(code)) {
        current.codes.delete(code);
        continue;
      }
      const entry = displays.get(code);
      const messageId = entry?.display.read()?.messageId;
      if (!entry || !messageId || !code.classList.contains("hljs")) {
        continue;
      }
      const box = code.getBoundingClientRect();
      const bottom = viewport.top + viewport.height * 2;
      if (!box.height || box.bottom <= viewport.top || box.top >= bottom) {
        continue;
      }
      const collapsed = code.closest(".is-collapsible");
      const lines = collapsed
        ? CODE_PREVIEW_LINE_COUNT
        : Math.ceil((bottom - box.top) / Number.parseFloat(getComputedStyle(code).lineHeight));
      const prepared = Number.isFinite(lines) ? captureCode(code, lines) : undefined;
      if (!prepared) {
        continue;
      }
      if (
        Object.keys(captured.rows[messageId] ?? {}).length >= 8 &&
        !captured.rows[messageId]?.[entry.key]
      ) {
        continue;
      }
      const classes = [...new Set([...captured.classes, ...prepared.classes])];
      if (classes.length > 32) {
        continue;
      }
      captured.classes = classes;
      for (let index = 2; index < prepared.offsets.runs.length; index += 3) {
        prepared.offsets.runs[index] = classes.indexOf(
          prepared.classes[prepared.offsets.runs[index]!]!,
        );
      }
      (captured.rows[messageId] ??= {})[entry.key] = prepared.offsets;
    }
  }
  return captured;
}
