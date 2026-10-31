import { findMarkdownCodeSpans } from "../../../packages/markdown-core/src/markdown-code-regions.js";
import type { MarkdownRenderOptions } from "./markdown-render-options.ts";
import { renderMarkdownHtml } from "./markdown-render.ts";

export {
  appendMarkdownTruncationNotice,
  HIGHLIGHTABLE_CODE_RE,
  MARKDOWN_CHAR_LIMIT,
  markdownRenderKey,
  partitionMarkdownHtml,
  renderSanitizedMarkdown,
  toSanitizedJsonHtml,
} from "./markdown-render.ts";

/** Full synchronous entry, including selected names that cross Markdown code delimiters. */
export function toSanitizedMarkdownHtml(
  markdown: string,
  options: MarkdownRenderOptions = {},
): string {
  return renderMarkdownHtml(markdown, options, findMarkdownCodeSpans);
}
