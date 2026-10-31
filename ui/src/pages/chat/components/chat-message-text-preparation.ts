import { markdownNeedsCodeOwnership } from "../../../components/markdown-human-mentions.ts";
import type { toStreamingMarkdownDomParts } from "../../../components/markdown-live.ts";
import {
  MARKDOWN_PARSE_LIMIT,
  type MarkdownRenderOptions,
} from "../../../components/markdown-render-options.ts";
import { partitionMarkdownHtml, renderMarkdownHtml } from "../../../components/markdown-render.ts";
import { markdownContentHtml, type MarkdownContent } from "../../../lib/markdown-content.ts";
import type { LinkFaviconFetcher } from "../link-favicon-cache.ts";

export type MessageTextOptions = {
  role: string;
  isStreaming: boolean;
  isForwarded?: boolean;
  fetchLinkFavicon?: LinkFaviconFetcher;
  isUserMessageExpanded?: (messageId: string) => boolean;
  onToggleUserMessageExpanded?: (messageId: string) => void;
  assistantMessageDisclosure?: AssistantMessageDisclosure;
};

export type AssistantMessageDisclosure = {
  expanded: boolean;
  markdown?: string;
  message?: unknown;
  /** Set when automatic full-message retries exhausted; invoking re-enters the loader. */
  onRetryFullMessage?: () => void;
};

function messageMarkdownInput(
  markdown: string,
  opts: MessageTextOptions,
  markdownRenderOptions: MarkdownRenderOptions,
) {
  const disclosure = opts.assistantMessageDisclosure;
  const isAssistant = opts.role === "assistant";
  const recoverFullMessage =
    isAssistant || (opts.role === "user" && Boolean(disclosure?.onRetryFullMessage));
  const recovered = recoverFullMessage && disclosure?.expanded;
  const source = recovered ? (disclosure.markdown ?? markdown) : markdown;
  const options: MarkdownRenderOptions = recovered
    ? { ...markdownRenderOptions, mode: "document" }
    : markdownRenderOptions;
  return { source, options, isAssistant, recovered, recoverFullMessage };
}

export function messageMarkdownNeedsCodeOwnership(
  markdown: string,
  opts: MessageTextOptions,
  markdownRenderOptions: MarkdownRenderOptions,
): boolean {
  const { source, options } = messageMarkdownInput(markdown, opts, markdownRenderOptions);
  return markdownNeedsCodeOwnership(source, options);
}

export function prepareMessageMarkdown(
  markdown: string,
  messageKey: string,
  opts: MessageTextOptions,
  markdownRenderOptions: MarkdownRenderOptions,
  renderStreaming?: typeof toStreamingMarkdownDomParts,
  mutableStreaming = false,
  renderMarkdown: (source: string, options: MarkdownRenderOptions) => string = renderMarkdownHtml,
) {
  const { source, options, isAssistant, recovered, recoverFullMessage } = messageMarkdownInput(
    markdown,
    opts,
    markdownRenderOptions,
  );
  const streaming = opts.isStreaming;
  const prepare = () => {
    let parts: [MarkdownContent, MarkdownContent] =
      streaming && renderStreaming
        ? renderStreaming(source, options, isAssistant ? messageKey : undefined)
        : partitionMarkdownHtml(renderMarkdown(source, options), messageKey);
    if (mutableStreaming) {
      parts = ["", markdownContentHtml(parts[0]) + markdownContentHtml(parts[1])];
    }
    return parts;
  };
  // Settled content must be prepared before the row's first measurement.
  const deferFormatting = streaming && !recovered && source.length <= MARKDOWN_PARSE_LIMIT;
  const eagerParts = deferFormatting ? undefined : prepare();
  return {
    messageKey,
    source,
    parts: eagerParts ? () => eagerParts : prepare,
    deferFormatting,
    recoverFullMessage,
  };
}
