import { ARTIFACT_DOWNLOAD_PATH } from "../../../../packages/gateway-protocol/src/artifact-download.ts";
import * as json from "../snapshot-json.ts";
import { readChatThreadMessageIdentity } from "./history-message-identity.ts";
import { removePairingQrContent } from "./pairing-qr.ts";

export const MAX_CHAT_THUMBNAILS = 32;
export const MAX_CHAT_THUMBNAIL_BYTES = 8 * 1024 * 1024;
const MAX_CHAT_THUMBNAIL_SIZE = 256 * 1024;

export function isChatThumbnail(value: Blob | undefined): value is Blob {
  return Boolean(
    value?.size &&
    value.size <= MAX_CHAT_THUMBNAIL_SIZE &&
    /^(?:image\/png|image\/jpeg|image\/webp|image\/avif)$/u.test(value.type),
  );
}

const text = json.refine(json.text, (value) => value.length <= 256);
const dimension = json.refine(
  json.number,
  (value) => Number.isInteger(value) && value > 0 && value <= 100_000,
);
const boundedRecord = <T>(reader: json.SnapshotReader<T>, max: number, keyLength = Infinity) =>
  json.refine(
    json.record(reader),
    (value) =>
      Object.keys(value).length <= max &&
      Object.keys(value).every((key) => key.length <= keyLength),
  );
const linkSchema = json.object({
  title: json.optional(text),
  badge: json.optional(
    json.object({
      label: text,
      tone: json.enumeration(["neutral", "positive", "negative", "attention", "accent"]),
    }),
  ),
});
const highlightClasses = new Set(
  [
    "keyword",
    "built_in",
    "type",
    "literal",
    "number",
    "operator",
    "punctuation",
    "property",
    "regexp",
    "string",
    "char",
    "subst",
    "symbol",
    "class",
    "title",
    "function",
    "params",
    "comment",
    "doctag",
    "meta",
    "section",
    "tag",
    "name",
    "attr",
    "attribute",
    "variable",
    "bullet",
    "code",
    "emphasis",
    "strong",
    "formula",
    "link",
    "quote",
    "selector-tag",
    "selector-id",
    "selector-class",
    "selector-attr",
    "selector-pseudo",
    "template-tag",
    "template-variable",
    "addition",
    "deletion",
  ]
    .map((scope) => `hljs-${scope}`)
    .concat([
      "language_",
      "constant_",
      "function_",
      "class_",
      "inherited__",
      "invoke__",
      "constructor_",
      "prompt_",
      "documentation_",
      "keyword_",
      "string_",
      "parameter_",
      "escape_",
      "special_",
      "heading_",
    ]),
);
export function isCodeHighlightClass(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 128 &&
    value.split(" ").every((name) => highlightClasses.has(name))
  );
}
export const codeHighlightClassesSchema = json.array(
  json.refine(json.text, isCodeHighlightClass),
  32,
);
const codeHighlightOffsetsSchema = json.object({
  end: json.refine(
    json.number,
    (value) => Number.isSafeInteger(value) && value >= 0 && value <= 50_000,
  ),
  runs: json.refine(
    json.array(json.number, 384),
    (runs) =>
      runs.length % 3 === 0 && runs.every((value) => Number.isSafeInteger(value) && value >= 0),
  ),
});
export type CodeHighlightOffsets = json.SnapshotValue<typeof codeHighlightOffsetsSchema>;
export type CapturedCodeRows = {
  classes: string[];
  rows: Record<string, Record<string, CodeHighlightOffsets>>;
};
export const chatRowDisplaySchema = json.object({
  code: json.optional(boundedRecord(codeHighlightOffsetsSchema, 8, 16)),
  links: json.optional(boundedRecord(linkSchema, 8, 4096)),
  images: json.optional(
    boundedRecord(
      json.object({
        width: dimension,
        height: dimension,
        rendition: json.checked((value): value is 480 | 960 => value === 480 || value === 960),
        // Browser-local display bytes, never a ticket or an authorization receipt.
        thumbnail: json.optional(
          json.checked((value): value is Blob => value instanceof Blob && isChatThumbnail(value)),
        ),
      }),
      8,
      4096,
    ),
  ),
});
export const rowDisplaySchema = boundedRecord(chatRowDisplaySchema, 80);
export const avatarSourcesSchema = boundedRecord(
  json.nullable(json.refine(json.text, (value) => value.length <= 2048)),
  24,
);
export type ChatRowDisplayFacts = json.SnapshotValue<typeof chatRowDisplaySchema>;
export type ChatLinkDisplay = json.SnapshotValue<typeof linkSchema>;
type RowDisplaySnapshot = { rowDisplay?: Record<string, ChatRowDisplayFacts> };

export type ChatRowDisplay = {
  read: () =>
    | {
        scope: string;
        messageId?: string;
        facts: ChatRowDisplayFacts | undefined;
        codeClasses?: string[];
      }
    | undefined;
  write: (update: Partial<ChatRowDisplayFacts>) => void;
};

export type ChatDisplayFacts = {
  forRow: (messageId: string | null) => ChatRowDisplay | undefined;
};

/** Retain source identity, never signed transport URLs or embedded credentials. */
export function chatDisplaySourceKey(source: string): string | undefined {
  if (source.length > 2048 || /^(?:data|blob):/u.test(source)) {
    return undefined;
  }
  const url = globalThis.location && URL.parse(source, globalThis.location.origin);
  return url &&
    !url.username &&
    !url.password &&
    !url.hash &&
    !url.pathname.includes(ARTIFACT_DOWNLOAD_PATH) &&
    [...url.searchParams.keys()].every((key) => key === "v")
    ? source
    : undefined;
}

export function chatImageDisplayKey(
  image: { url?: string; artifactId?: string },
  rendition: 480 | 960,
): string | undefined {
  return image.url && !chatDisplaySourceKey(image.url)
    ? undefined
    : JSON.stringify([image.artifactId ?? null, image.url ?? null, rendition]);
}

/** Display facts cannot outlive the transcript window they describe. */
export function projectChatRowDisplay(
  snapshot: RowDisplaySnapshot & { messages: unknown[] },
  start = 0,
): RowDisplaySnapshot["rowDisplay"] {
  if (!snapshot.rowDisplay) {
    return undefined;
  }
  const rows: NonNullable<RowDisplaySnapshot["rowDisplay"]> = {};
  for (const message of snapshot.messages.slice(Math.max(start, snapshot.messages.length - 80))) {
    const id = readChatThreadMessageIdentity(message)?.id;
    if (id && snapshot.rowDisplay[id] && removePairingQrContent(message) === message) {
      rows[id] = snapshot.rowDisplay[id]!;
    }
  }
  return Object.keys(rows).length === Object.keys(snapshot.rowDisplay).length
    ? snapshot.rowDisplay
    : rows;
}

export function chatThumbnailWeight(snapshot: RowDisplaySnapshot) {
  let count = 0;
  let bytes = 0;
  for (const row of Object.values(snapshot.rowDisplay ?? {})) {
    for (const image of Object.values(row.images ?? {})) {
      if (image.thumbnail) {
        count++;
        bytes += image.thumbnail.size;
      }
    }
  }
  return { count, bytes };
}

export function boundChatThumbnails<S extends RowDisplaySnapshot>(
  snapshot: S,
  budget = { count: MAX_CHAT_THUMBNAILS, bytes: MAX_CHAT_THUMBNAIL_BYTES },
): S {
  let rowDisplay: typeof snapshot.rowDisplay;
  for (const [id, row] of Object.entries(snapshot.rowDisplay ?? {}).toReversed()) {
    for (const [key, image] of Object.entries(row.images ?? {}).toReversed()) {
      const blob = image.thumbnail;
      if (!blob) {
        continue;
      }
      if (budget.count > 0 && blob.size <= budget.bytes && blob.size <= MAX_CHAT_THUMBNAIL_SIZE) {
        budget.count--;
        budget.bytes -= blob.size;
        continue;
      }
      rowDisplay ??= { ...snapshot.rowDisplay };
      if (rowDisplay[id] === row) {
        rowDisplay[id] = { ...row, images: { ...row.images } };
      }
      const { thumbnail: _thumbnail, ...dimensions } = image;
      rowDisplay[id]!.images![key] = dimensions;
    }
  }
  return rowDisplay ? { ...snapshot, rowDisplay } : snapshot;
}
