import { parse, postprocess, preprocess } from "micromark";
import { gfmTable } from "micromark-extension-gfm-table";

type MarkdownCodeRegion = { start: number; end: number; block: boolean };

/** Resolve ordinary paragraphs and top-level fences without tokenizing their contents. */
function scanSimpleCodeRegions(text: string): MarkdownCodeRegion[] | undefined {
  if (/\r(?!\n)/u.test(text)) {
    return undefined;
  }
  const regions: MarkdownCodeRegion[] = [];
  let paragraphStart: number | undefined;
  let fence: { start: number; marker: string } | undefined;
  const finishParagraph = (end: number) => {
    if (paragraphStart === undefined) {
      return true;
    }
    const runs = [...text.slice(paragraphStart, end).matchAll(/`+/gu)];
    const nextByLength = new Map<number, number>();
    const candidates: MarkdownCodeRegion[] = [];
    // Index closers once: an unmatched run must not repeatedly search the paragraph.
    for (const run of runs.toReversed()) {
      let slashes = 0;
      const start = paragraphStart + run.index;
      for (let at = start - 1; at >= paragraphStart && text[at] === "\\"; at--) {
        slashes++;
      }
      const escaped = slashes % 2;
      const close = nextByLength.get(run[0].length - escaped);
      if (close !== undefined) {
        candidates.push({ start: start + escaped, end: close, block: false });
      }
      // Inside code a backslash cannot escape a closing backtick run.
      nextByLength.set(run[0].length, start + run[0].length);
    }
    let consumed = paragraphStart;
    for (const candidate of candidates.toReversed()) {
      if (candidate.start >= consumed) {
        if (/[[<]/u.test(text.slice(consumed, candidate.start))) {
          return false;
        }
        regions.push(candidate);
        consumed = candidate.end;
      }
    }
    if (/[[<]/u.test(text.slice(consumed, end))) {
      return false;
    }
    paragraphStart = undefined;
    return true;
  };
  for (let start = 0; start < text.length;) {
    const newline = text.indexOf("\n", start);
    const end = newline < 0 ? text.length : newline;
    const line = text.slice(start, text[end - 1] === "\r" ? end - 1 : end);
    const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
    const run = marker?.[1];
    if (fence) {
      if (
        run &&
        run[0] === fence.marker[0] &&
        run.length >= fence.marker.length &&
        marker &&
        /^[ \t]*$/u.test(line.slice(marker[0].length))
      ) {
        regions.push({ start: fence.start, end: start + line.length, block: true });
        fence = undefined;
      }
    } else if (marker && run) {
      if (run[0] === "`" && line.slice(marker[0].length).includes("`")) {
        return undefined;
      }
      if (!finishParagraph(start)) {
        return undefined;
      }
      fence = { start: start + marker[0].length - run.length, marker: run };
    } else if (/^[ \t]*$/u.test(line)) {
      if (!finishParagraph(start)) {
        return undefined;
      }
    } else {
      // Containers, references, links, autolinks, headings and tables retain the
      // canonical grammar. Their later lines can change earlier code ownership.
      if (
        /[\t|]/u.test(line) ||
        /^(?: {4}| {0,3}(?:[>#*+_=:-]|\d{1,9}[.)](?:[ \t]|$)))/u.test(line)
      ) {
        return undefined;
      }
      paragraphStart ??= start;
    }
    start = end + 1;
  }
  if (!finishParagraph(text.length)) {
    return undefined;
  }
  if (fence) {
    regions.push({ start: fence.start, end: text.length, block: true });
  }
  return regions;
}

/** Read exact original UTF-16 code ranges without building a Markdown tree. */
export function findMarkdownCodeRegions(text: string): MarkdownCodeRegion[] {
  if (!/[`~\t]| {4}/u.test(text)) {
    return [];
  }
  const scanned = scanSimpleCodeRegions(text);
  if (scanned) {
    return scanned;
  }
  const events = postprocess(
    parse({ extensions: [{ disable: { null: ["htmlFlow", "htmlText"] } }, gfmTable()] })
      .document()
      .write(preprocess()(text, undefined, true)),
  );
  const regions: MarkdownCodeRegion[] = [];
  let imageDepth = 0;
  for (const [phase, token] of events) {
    if (token.type === "image") {
      imageDepth += phase === "enter" ? 1 : -1;
    }
    // Resolved image labels become alt text, so their inline code is not protected.
    if (
      phase === "enter" &&
      imageDepth === 0 &&
      (token.type === "codeText" || token.type === "codeFenced" || token.type === "codeIndented")
    ) {
      regions.push({
        start: token.start.offset,
        end: token.end.offset,
        block: token.type !== "codeText",
      });
    }
  }
  return regions;
}

export function findMarkdownCodeSpans(text: string): Array<[number, number]> {
  return findMarkdownCodeRegions(text).map(({ start, end }) => [start, end]);
}
