import { Loading } from "solid-js";
import { expect, it, vi } from "vitest";
import { MarkdownHtml } from "../../../components/solid/markdown-html.tsx";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { MessageMarkdown } from "./chat-message-text-view.tsx";

const readiness = vi.hoisted(() =>
  Promise.withResolvers<typeof import("../../../components/markdown-full.ts")>(),
);
// mock-isolation: hold the real renderer's delivery to exercise first-render readiness.
vi.mock("../../../components/markdown-full-loader.ts", () => ({
  loadFullMarkdown: Object.assign(() => readiness.promise, { peek: () => undefined }),
}));

it("waits for exact code ownership before mounting selected-name text", async () => {
  const source = "Before `@Ada` tail";
  const options = {
    humanMentions: [{ profileId: "synthetic-ada", start: source.indexOf("@"), end: source.length }],
  };
  const mounted = mountSolid(() => (
    <Loading fallback={<span>Preparing text</span>}>
      <MessageMarkdown
        markdown={source}
        messageKey="synthetic-code-ownership"
        options={{ role: "user", isStreaming: false }}
        markdownOptions={options}
      />
      <MarkdownHtml markdown={source} options={options} class="generic-markdown" />
    </Loading>
  ));
  try {
    flush();
    expect(mounted.container.textContent).toBe("Preparing text");
    expect(mounted.container.querySelector(".chat-text")).toBeNull();
    readiness.resolve(await import("../../../components/markdown-full.ts"));
    await waitForSolid(() => {
      expect(mounted.container.querySelector(".chat-text code")?.textContent).toBe("@Ada");
      expect(mounted.container.querySelector(".generic-markdown code")?.textContent).toBe("@Ada");
    });
    expect(mounted.container.querySelector("openclaw-person-reference")).toBeNull();
    expect(mounted.container.textContent).not.toContain("openclawhumanmention");
  } finally {
    readiness.resolve(await import("../../../components/markdown-full.ts"));
    mounted.unmount();
  }
});
