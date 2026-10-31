import { dynamic, type JSX } from "@solidjs/web";
import { createMemo } from "solid-js";
import { loadFullMarkdown } from "../markdown-full-loader.ts";
import { markdownNeedsCodeOwnership } from "../markdown-human-mentions.ts";
import { renderMarkdownHtml as toSanitizedMarkdownHtml } from "../markdown-render.ts";

export function MarkdownHtml(props: {
  markdown: string;
  class?: string;
  dir?: "ltr" | "rtl" | "auto";
  style?: JSX.CSSProperties | string;
  as?: "div" | "p" | "article";
  options?: Parameters<typeof toSanitizedMarkdownHtml>[1];
}) {
  const Tag = dynamic(() => props.as ?? "div");
  const fullMarkdown = createMemo(() =>
    markdownNeedsCodeOwnership(props.markdown, props.options ?? {})
      ? (loadFullMarkdown.peek() ?? loadFullMarkdown())
      : undefined,
  );
  return (
    <Tag
      class={props.class}
      dir={props.dir}
      style={props.style}
      // oxlint-disable-next-line solid/no-innerhtml -- The shared Markdown renderer sanitizes this sole HTML sink.
      innerHTML={(fullMarkdown()?.toSanitizedMarkdownHtml ?? toSanitizedMarkdownHtml)(
        props.markdown,
        props.options,
      )}
    />
  );
}
