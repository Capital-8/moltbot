import MarkdownIt, { type Token } from "markdown-it";

function createDisclosureCodeReader() {
  const parser = new MarkdownIt({ html: false });
  // Ownership includes syntactically valid image labels regardless of URL safety.
  // The rendering parser and sanitizer still enforce their own URL policy.
  parser.validateLink = () => true;
  const rules = parser.inline.ruler;
  const enabled = rules.getRules("");
  rules.disable("backticks");
  const withoutBackticks = new Set(rules.getRules(""));
  const backticks = enabled.find((rule) => !withoutBackticks.has(rule));
  if (!backticks) {
    throw new Error("Markdown parser has no backticks rule");
  }
  rules.enable("backticks");
  let source = "";
  let spans: Array<[number, number]> = [];
  rules.at("backticks", (state, silent) => {
    const start = state.pos;
    const count = state.tokens.length;
    const matched = backticks(state, silent);
    if (
      !silent &&
      state.src === source &&
      state.tokens.length > count &&
      state.tokens.at(-1)?.type === "code_inline"
    ) {
      spans.push([start, state.pos]);
    }
    return matched;
  });
  return (line: string): Array<[number, number]> => {
    source = line;
    spans = [];
    const blocks: Token[] = [];
    parser.block.parse(line, parser, {}, blocks);
    // Disclosure scans are line-local. Indented code has no structural tags.
    if (blocks.some((token) => token.type === "code_block")) {
      return [[0, line.length]];
    }
    // Parse the original line: block token content has already lost indentation.
    // Image alt parsing uses a shorter source; links keep this source and offsets.
    parser.inline.parse(line, parser, {}, []);
    return spans;
  };
}

let readDisclosureCode: ReturnType<typeof createDisclosureCodeReader> | undefined;

/** Native inline ownership with offsets in the original, single disclosure line. */
export function findDisclosureLineCodeSpans(line: string): Array<[number, number]> {
  if (!/[`\t]| {4}/u.test(line)) {
    return [];
  }
  return (readDisclosureCode ??= createDisclosureCodeReader())(line);
}
