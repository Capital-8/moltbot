import { describe, expect, it } from "vitest";
import { findMarkdownCodeSpans } from "../../../packages/markdown-core/src/markdown-code-regions.js";
import { scanMarkdownDisclosureLine } from "./markdown-details.ts";

describe("disclosure line code ownership", () => {
  it.each([
    "<details> `literal </details>` <summary>Real</summary>",
    "<details> ``literal ` </details>`` <summary>Real</summary>",
    "<details> \\`not code </details> \\`",
    "<details> ![`alt </details>`](/image) <summary>Real</summary>",
    "<details> ![`alt </details>`](javascript:alert) <summary>Real</summary>",
    "<details> ![`pending </details>`][missing] <summary>Real</summary>",
    "<details> [`linked </details>`](/link) <summary>Real</summary>",
    '<details> [label](/path "title `</details>`") <summary>Real</summary>',
    "   <details> `literal </details>` <summary>Real</summary>",
    "    <details> <summary>Literal code</summary>",
    "\t<details> <summary>Literal code</summary>",
  ])("matches canonical disclosure ownership at every prefix: %j", (line) => {
    for (let end = 0; end <= line.length; end++) {
      const prefix = line.slice(0, end);
      expect(scanMarkdownDisclosureLine(prefix)).toEqual(
        scanMarkdownDisclosureLine(prefix, findMarkdownCodeSpans(prefix)),
      );
    }
  });
});
