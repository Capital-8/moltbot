import { describe, expect, it } from "vitest";
import { findMarkdownCodeRegions } from "./markdown-code-regions.js";
import { findMarkdownCodeRegions as findTreeCodeRegions } from "./reasoning-tags.js";

describe("range-only Markdown ownership", () => {
  it("protects link text and unresolved image text, but not resolved image alt text", () => {
    const text = "`shown` ![`alt`](/image) [`linked`](/link) ![`pending`][id]";
    expect(findMarkdownCodeRegions(text).map(({ start, end }) => text.slice(start, end))).toEqual([
      "`shown`",
      "`linked`",
      "`pending`",
    ]);
    expect(
      findMarkdownCodeRegions(text + "\n\n[id]: /image").map(({ start, end }) =>
        text.slice(start, end),
      ),
    ).toEqual(["`shown`", "`linked`"]);
  });

  it("retains exact raw offsets through partially expanded container tabs", () => {
    expect(findMarkdownCodeRegions(">\t\t`code`\n>\tmore")).toEqual([
      { start: 2, end: 9, block: true },
    ]);
  });

  it("keeps original CRLF offsets across inline code in a quote", () => {
    const text = "> `code\r\n> more`\r\n";
    expect(findMarkdownCodeRegions(text)).toEqual([{ start: 2, end: 16, block: false }]);
  });

  it("retains the canonical iterative grammar for deeply nested quotes", () => {
    const text = "> ".repeat(10_000) + "`<think>x</think>`";
    expect(findMarkdownCodeRegions(text)).toEqual([{ start: 20_000, end: 20_018, block: false }]);
  });

  it.each([
    "> ```xml\n> <internal>literal</internal>\n> ",
    "- item\n\n      <parameter>literal</parameter>\n\n      ",
    "| a | b |\n| - | - |\n| `a\\|b` | y |",
    '![a `<|assistant|>`][id]\n\n[id]: /image "title" x',
    '[a](/link "title `<internal>literal</internal>`")',
    "Use `[[reply_to_current]]` and ``a`b`` literally.\n\n~~~text\n<parameter>x</parameter>\n~~~\n",
    "  ````typescript\n```nested\n~~~tilde\n  ````  \n\n```unfinished\nbody\n",
    "before \\`escaped` and ``unmatched `paired` tail\n\nnext `paragraph`",
    "before `a\\` then `b` and \\\\`c`\r\nafter",
    "before `open\ncontinued` then `split\n\nparagraph`",
    "``` invalid `info\ntext\n```\n",
    "a `open\n:---:\nclose`",
  ])("matches full ownership at every prefix: %j", (text) => {
    for (let end = 0; end <= text.length; end++) {
      const prefix = text.slice(0, end);
      expect(findMarkdownCodeRegions(prefix)).toEqual(findTreeCodeRegions(prefix));
    }
  });

  it("scans a 20 MiB agent response within the main-thread budget", () => {
    const unit =
      "The result preserves `[[reply_to_current]]` and ``a`b`` as source.\n\n" +
      '````typescript\nconst reply = "[[reply_to_current]]";\n```nested\n~~~tilde\n````\n\n' +
      "~~~text\n<parameter>synthetic</parameter>\n~~~\n";
    const repeats = Math.ceil((20 * 1024 * 1024) / unit.length);
    const text = unit.repeat(repeats);
    const started = performance.now();
    const regions = findMarkdownCodeRegions(text);
    const elapsed = performance.now() - started;
    expect(regions).toHaveLength(repeats * 4);
    expect(regions.at(-1)).toEqual({
      start: text.length - "~~~text\n<parameter>synthetic</parameter>\n~~~\n".length,
      end: text.length - 1,
      block: true,
    });
    expect(elapsed).toBeLessThan(2_000);
  });
});
