import { createSignal, flush } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import type { ChatRowDisplayFacts } from "../lib/chat/row-display-facts.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { renderSolidRef } from "../test-helpers/render-solid-ref.ts";
import { captureMarkdownCodeRows, trackMarkdownCodeDisplay } from "./markdown-code-display.ts";
import { createMarkdownRef } from "./markdown-dom-ref.ts";
import { highlightCodeHtml } from "./markdown-highlight-runtime.ts";
import { updateLinkReaderDisplay } from "./markdown-link-display.ts";
import { toStreamingMarkdownDomParts } from "./markdown-live.ts";
import { partitionMarkdownHtml, toSanitizedMarkdownHtml } from "./markdown.ts";

it.each([1, 28])("restores the visible syntax of a %i-line cached fence before commit", (lines) => {
  let facts: ChatRowDisplayFacts = {};
  let codeClasses: string[] = [];
  const display = {
    read: () => ({ scope: "cached-code", messageId: "cached-code", facts, codeClasses }),
    write: (update: Partial<ChatRowDisplayFacts>) => {
      facts = { ...facts, ...update };
    },
  };
  const mount = (html: string) =>
    renderSolidRef(
      () =>
        createMarkdownRef(
          () => ({ content: `<div class="is-collapsible">${html}</div>`, incremental: true }),
          () => display,
        ),
      {
        targetElement: Object.assign(document.createElement("div"), {
          className: "chat-virtual-row",
        }),
      },
    );
  const source = "const cached = true;\n".repeat(lines);
  const warm = mount(
    `<pre><code class="hljs language-ts">${highlightCodeHtml(source, "ts")}</code></pre>`,
  );
  const code = warm.container.querySelector<HTMLElement>("code")!;
  vi.spyOn(code, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 600, 140));
  trackMarkdownCodeDisplay(code);
  const captured = captureMarkdownCodeRows(
    [{ element: code.closest<HTMLElement>(".chat-virtual-row")!, start: 0, end: 1000 }],
    { top: 0, height: 400, offset: 0 },
    () => {},
  );
  facts = { code: captured.rows["cached-code"] };
  codeClasses = captured.classes;
  warm.unmount();
  // The persisted display record and raw message are the only inputs after reload.
  facts = JSON.parse(JSON.stringify(facts));
  const reload = mount(`<pre><code class="language-ts">${source}</code></pre>`);
  expect(reload.container.querySelector("code")?.textContent).toBe(source);
  expect(
    [...reload.container.querySelectorAll("code span")].map((span) => [
      span.className,
      span.textContent,
    ]),
  ).toEqual(
    Array.from({ length: Math.min(lines, 7) }, () => [
      ["hljs-keyword", "const"],
      ["hljs-literal", "true"],
    ]).flat(),
  );
  reload.unmount();
  const changed = mount('<pre><code class="language-ts">changed source</code></pre>');
  expect(changed.container.querySelector("code")?.textContent).toBe("changed source");
  expect(changed.container.querySelector(".hljs-keyword")).toBeNull();
  changed.unmount();
});

it("captures visible and lower-margin fences while excluding earlier and distant rows", () => {
  const mounts: ReturnType<typeof renderSolidRef>[] = [];
  const items = [-300, 100, 600, 1000].map((top, index) => {
    const view = renderSolidRef(
      () =>
        createMarkdownRef(
          () => ({
            content: `<div class="is-collapsible"><pre><code class="hljs language-ts">${highlightCodeHtml("const ready = true;\n", "ts")}</code></pre></div>`,
          }),
          () => ({
            read: () => ({ scope: `scope-${index}`, messageId: `row-${index}`, facts: {} }),
            write: () => {},
          }),
        ),
      {
        targetElement: Object.assign(document.createElement("div"), {
          className: "chat-virtual-row",
        }),
      },
    );
    mounts.push(view);
    const code = view.container.querySelector<HTMLElement>("code")!;
    vi.spyOn(code, "getBoundingClientRect").mockReturnValue(new DOMRect(0, top, 600, 140));
    trackMarkdownCodeDisplay(code);
    return { element: code.closest<HTMLElement>(".chat-virtual-row")!, start: top, end: top + 140 };
  });
  onTestFinished(() => mounts.forEach((view) => view.unmount()));
  const captured = captureMarkdownCodeRows(items, { top: 0, height: 400, offset: 0 }, () => {});
  expect(Object.keys(captured.rows)).toEqual(["row-1", "row-2"]);
  expect(captured.classes).toEqual(["hljs-keyword", "hljs-literal"]);
});

it("publishes only differing PR facts and excludes query-bearing URLs from the cache", () => {
  const pr = "https://github.com/example/project/pull/42";
  const queryPr = `${pr}?access_token=synthetic-fixture`;
  let facts: ChatRowDisplayFacts = {
    links: {
      [`pr:${pr}`]: { title: "Synthetic change", badge: { label: "Open", tone: "positive" } },
    },
  };
  const write = vi.fn((update: Partial<ChatRowDisplayFacts>) => {
    facts = { ...facts, ...update };
  });
  const display = { read: () => ({ scope: "cached-markdown", facts }), write };
  const html = toSanitizedMarkdownHtml(`${pr}\n\n${queryPr}`);
  const view = renderSolidRef(
    () =>
      createMarkdownRef(
        () => ({ content: html }),
        () => display,
      ),
    {
      targetElement: document.createElement("div"),
    },
  );
  onTestFinished(() => view.unmount());
  const link = view.container.querySelector<HTMLAnchorElement>("a.markdown-github-item")!;
  expect(link.getAttribute("aria-description")).toBe("Open");
  expect(link.dataset.linkReaderTone).toBe("positive");
  const queryLink =
    view.container.querySelectorAll<HTMLAnchorElement>("a.markdown-github-item")[1]!;
  expect(queryLink.getAttribute("aria-description")).toBeNull();
  const observer = new MutationObserver(() => undefined);
  observer.observe(view.container, { attributes: true, childList: true, subtree: true });
  try {
    updateLinkReaderDisplay(link, {
      url: pr,
      title: "Synthetic change",
      badge: { label: "Open", tone: "positive" },
    });
    expect(observer.takeRecords()).toEqual([]);
    expect(write).not.toHaveBeenCalled();
    updateLinkReaderDisplay(link, {
      url: pr,
      title: "Synthetic change",
      badge: { label: "Merged", tone: "accent" },
    });
    expect(link.dataset.linkReaderTone).toBe("accent");
    expect(facts.links?.[`pr:${pr}`]?.badge).toEqual({ label: "Merged", tone: "accent" });
    expect(write).toHaveBeenCalledOnce();
    updateLinkReaderDisplay(queryLink, {
      url: queryPr,
      title: "Query-specific preview",
      badge: { label: "Closed", tone: "neutral" },
    });
    expect(write).toHaveBeenCalledOnce();
    expect(Object.keys(facts.links ?? {})).toEqual([`pr:${pr}`]);
  } finally {
    observer.disconnect();
  }
});

it("commits Markdown before onUpdate and retires a replaced island", () => {
  const container = document.body.appendChild(document.createElement("div"));
  const [html, setHtml] = createSignal('<a href="#first">First</a>');
  const onUpdate = vi.fn(() => container.textContent);
  let bind!: (element: ParentNode) => void;
  const view = renderSolidRef(
    () => (bind = createMarkdownRef(() => ({ content: html(), onUpdate }))),
    { container, targetElement: document.createElement("div") },
  );
  onTestFinished(() => container.remove());
  expect(onUpdate).toHaveLastReturnedWith("First");
  const original = view.getByRole("link", { name: "First" });
  const replacement = container.appendChild(document.createElement("section"));
  bind(replacement);
  setHtml('<a href="#second">Second</a>');
  flush();
  expect(onUpdate).toHaveLastReturnedWith("Second");
  expect(original.isConnected).toBe(false);
  const current = view.getByRole("link", { name: "Second" });
  expect(replacement.contains(current)).toBe(true);

  view.unmount();
  expect(current).toMatchObject({ isConnected: false });
  expect(replacement.childNodes).toHaveLength(0);
});

it.each([
  ["paragraph", "A growing reply", "p"],
  ["list", "- First item\n- Growing item", "ul"],
  ["code fence", "```text\nA growing block", "pre"],
])("retains every node across 12 %s updates", (_label, initial, selector) => {
  const [source, setSource] = createSignal(initial);
  const { container: target } = mountSolid(() => {
    const fragment = document.createDocumentFragment();
    createMarkdownRef(() => ({
      content: {
        messageKey: "stream",
        source: source(),
        parts: toStreamingMarkdownDomParts(source()),
      },
    }))(fragment);
    return Array.from(fragment.childNodes);
  });
  const retained = target.querySelector(selector);
  expect(retained).not.toBeNull();
  const observer = new MutationObserver(() => {});
  observer.observe(target, { childList: true, subtree: true, characterData: true });
  onTestFinished(() => observer.disconnect());
  for (let index = 1; index <= 12; index++) {
    setSource(initial + " with more text".repeat(index));
    flush();
  }
  const mutations = observer.takeRecords();
  expect(target.querySelector(selector)).toBe(retained);
  expect(mutations.flatMap((mutation) => [...mutation.removedNodes])).toHaveLength(0);
  expect(retained?.textContent).toContain(" with more text".repeat(12));
  expect(mutations.some((mutation) => mutation.type === "characterData")).toBe(true);
});

it("retires retained media when the Solid owner unmounts", () => {
  const dispose = vi.fn();
  const setConnected = vi.fn();
  const target = document.createElement("div");
  const media = {
    prefix: "MEDIA",
    render: (_index: number, container: HTMLElement) => {
      container.textContent = "Attachment";
      return { dispose, setConnected };
    },
  };
  const read = () => ({ content: "<p>MEDIA0END</p>", media });
  const view = renderSolidRef(() => createMarkdownRef(read), { targetElement: target });
  expect(target.textContent).toBe("Attachment");
  expect(setConnected).toHaveBeenCalledWith(true);
  view.unmount();
  expect(dispose).toHaveBeenCalledOnce();
  expect(target.childNodes).toHaveLength(0);
});

it("retains external long-code decoration until the exact source changes", () => {
  const markup = (code: string, prose: string) =>
    `<div class="code-block-wrapper"><div class="code-block-viewport"><pre><code data-code-highlight="ts">${code}</code></pre></div></div><p>${prose}</p>`;
  const [html, setHtml] = createSignal(markup("before", "First"));
  const view = renderSolidRef(
    () => createMarkdownRef(() => ({ content: html(), incremental: true })),
    { targetElement: document.createElement("div") },
  );
  const code = view.container.querySelector("code")!;
  const wrapper = view.container.querySelector(".code-block-wrapper");
  expect([...code.childNodes].map((node) => node.nodeType)).toEqual([Node.TEXT_NODE]);
  const highlighted = document.createElement("span");
  highlighted.className = "hljs-keyword";
  highlighted.textContent = "before";
  code.replaceChildren(highlighted);
  setHtml(markup("before", "Unrelated prose"));
  flush();
  expect(view.container.querySelector("code")).toBe(code);
  expect(code.firstChild).toBe(highlighted);
  setHtml(markup("after", "Unrelated prose"));
  flush();
  expect(view.container.querySelector(".code-block-wrapper")).toBe(wrapper);
  expect(view.container.querySelector("code")).not.toBe(code);
  expect(code.isConnected).toBe(false);
  expect(view.container.querySelector("code")?.textContent).toBe("after");
});

it("hands a closed stream fence to the code owner and retains its decoration at completion", () => {
  const codeSource = "const value = 1;\n".repeat(400);
  const [source, setSource] = createSignal("```ts\n" + codeSource);
  const [streaming, setStreaming] = createSignal(true);
  const options = { codeBlockInteraction: "interactive" } as const;
  const view = renderSolidRef(
    () =>
      createMarkdownRef(() => ({
        content: {
          messageKey: "large-fence-stream",
          source: source(),
          parts: streaming()
            ? toStreamingMarkdownDomParts(source(), options, "large-fence-stream")
            : partitionMarkdownHtml(
                toSanitizedMarkdownHtml(source(), options),
                "large-fence-stream",
              ),
        },
      })),
    { targetElement: document.createElement("div") },
  );
  expect(view.container.querySelector("code[data-code-highlight]")).toBeNull();
  expect(view.container.querySelector("code")?.textContent).toBe(codeSource);
  setSource(source() + "```\n\nDone.");
  flush();
  const code = view.container.querySelector("code[data-code-highlight]")!;
  expect(code).not.toBeNull();
  const highlighted = document.createElement("span");
  highlighted.className = "hljs-keyword";
  highlighted.textContent = codeSource;
  code.replaceChildren(highlighted);
  setStreaming(false);
  flush();
  expect(view.container.querySelector("code[data-code-highlight]")).toBe(code);
  expect(code.firstChild).toBe(highlighted);
  expect(code.textContent).toBe(codeSource);
});
