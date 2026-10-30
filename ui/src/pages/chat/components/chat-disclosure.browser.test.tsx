import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { retryStaleChunkReloadWhenReachable } from "../../../app/stale-chunk-reload.ts";
import type { MessageGroup as MessageGroupData } from "../../../lib/chat/chat-types.ts";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";
import { mountSolid as mountView } from "../../../test-helpers/mount-solid.ts";
import "../../../styles.css";
import "../../../styles/chat.ts";
import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ChatActivityHeadline } from "./chat-activity-headline.solid.tsx";
import { ActivityGroup, MessageGroup } from "./chat-message-group-view.tsx";
import { chatRichPresentation } from "./chat-rich-presentation.ts";
import { ChatThread } from "./chat-thread-view.tsx";
import { ChatToolCard } from "./chat-tool-cards.solid.tsx";
import { RawOutputToggle } from "./chat-tool-raw-output.tsx";
import { settleToolBridges } from "./chat-tool-render.test-support.ts";
import { createChatTranscript } from "./chat-transcript-controller.ts";
import { threadProps } from "./chat-transcript.test-support.ts";
import { WorkGroupSummary } from "./chat-work-group-summary.tsx";

// Keep the real recovery button handler without navigating the browser test page.
vi.mock("../../../app/stale-chunk-reload.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../app/stale-chunk-reload.ts")>()),
  retryStaleChunkReloadWhenReachable: vi.fn(async () => false),
}));

const browserMode = "__vitest_browser__" in globalThis;
let userEvent: (typeof import("vitest/browser"))["userEvent"];
let container: HTMLDivElement;
beforeAll(async () => {
  if (browserMode) {
    ({ userEvent } = await import("vitest/browser"));
  }
});
afterEach(() => {
  window.getSelection()?.removeAllRanges();
  if (container) {
    container.remove();
  }
});

function group(
  key: string,
  message: MessageGroupData["messages"][number]["message"],
  role: MessageGroupData["role"] = "tool",
): MessageGroupData {
  return {
    kind: "group",
    key,
    role,
    timestamp: 1000,
    isStreaming: false,
    visibleContent: role === "assistant" ? "text" : "non-text",
    messages: [{ key, hasVisibleContent: true, message }],
  };
}

describe.runIf(browserMode)("chat disclosure activation", () => {
  it("keeps failed rich-content recovery reachable at the end of retained plain history", async () => {
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof chatRichPresentation.load>>>();
    const ready = vi.spyOn(chatRichPresentation, "ready").mockReturnValue(false);
    const load = vi.spyOn(chatRichPresentation, "load").mockReturnValue(pending.promise);
    vi.mocked(retryStaleChunkReloadWhenReachable).mockClear();
    container = document.body.appendChild(document.createElement("div"));
    container.className = "rich-preparation-browser";
    container.style.width = "min(800px, 100%)";
    const transcript = createChatTranscript(() => "rich-recovery-browser");
    const props = threadProps(
      "rich-recovery-browser",
      "agent:main:rich-recovery-browser",
      Array.from({ length: 60 }, (_, index) => ({
        role: index % 2 === 0 ? "assistant" : "user",
        content: `Plain history message ${index}. This conversation remains readable while the next message loads.`,
        timestamp: index + 1,
        __openclaw: { id: `rich-recovery-${index}` },
      })),
      {
        stream: "Plain live answer",
        streamStartedAt: 100,
        runActive: true,
        onSetReply: () => {},
      },
    );
    const settleLayout = async () => {
      for (let frame = 0; frame < 4; frame++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        flush();
      }
    };
    transcript.start();
    const view = mountSolid(ChatThread, { props, transcript }, container);
    try {
      const style = container.appendChild(document.createElement("style"));
      style.textContent =
        ".rich-preparation-browser .chat-thread-viewport { height: 400px; flex: none; }";
      transcript.update();
      await settleLayout();
      transcript.scrollToEnd({ behavior: "instant", source: "manual" });
      await settleLayout();
      await waitForSolid(() => expect(transcript.isPositionSettled).toBe(true));
      const viewport = container.querySelector<HTMLDivElement>(".chat-thread")!;
      expect(viewport.scrollTop).toBeGreaterThan(viewport.clientHeight);
      expect(load).not.toHaveBeenCalled();
      const reply = [
        ...container.querySelectorAll<HTMLButtonElement>('button[aria-label="Reply to message"]'),
      ].at(-1)!;
      expect(reply).toBeDefined();
      reply.focus({ preventScroll: true });
      const rows = [...container.querySelectorAll<HTMLElement>("[data-virtual-row-key]")];
      const positions = rows.map((row) => row.getBoundingClientRect().top);
      const scrollTop = viewport.scrollTop;
      const scrollHeight = viewport.scrollHeight;
      const stream = container.querySelector<HTMLElement>(".chat-bubble.streaming")!;
      expect(stream.textContent).toContain("Plain live answer");
      const retained = () => {
        expect(document.activeElement).toBe(reply);
        expect(viewport.scrollTop).toBeCloseTo(scrollTop, 0);
        expect(viewport.scrollHeight).toBe(scrollHeight);
        expect(container.querySelector(".chat-bubble.streaming")).toBe(stream);
        expect(stream.textContent).toContain("Plain live answer");
        expect(stream.textContent).not.toContain("First rich live answer");
        const current = container.querySelectorAll("[data-virtual-row-key]");
        expect(current.length).toBe(rows.length);
        rows.forEach((row, index) => {
          expect(current[index]).toBe(row);
          expect(row.getBoundingClientRect().top).toBeCloseTo(positions[index]!, 0);
        });
      };

      view.update({
        props: { ...props, stream: "First rich live answer\nMEDIA:https://example.com/proof.png" },
        transcript,
      });
      transcript.update();
      await waitForSolid(() => expect(load).toHaveBeenCalledOnce());
      await settleLayout();
      retained();
      pending.reject(new Error("Rich content could not load"));
      await waitForSolid(() =>
        expect(container.querySelector(".chat-transcript-preparation [role=alert]")).not.toBeNull(),
      );
      await settleLayout();
      retained();
      const reload = container.querySelector<HTMLButtonElement>(
        ".chat-transcript-preparation .lazy-view-error__action",
      )!;
      expect(reload.textContent).toBe("Reload");
      const bounds = reload.getBoundingClientRect();
      const port = viewport.getBoundingClientRect();
      expect(bounds.top).toBeGreaterThanOrEqual(port.top);
      expect(bounds.bottom).toBeLessThanOrEqual(port.bottom);
      expect(bounds.left).toBeGreaterThanOrEqual(port.left);
      expect(bounds.right).toBeLessThanOrEqual(port.right);
      expect(
        reload.contains(
          document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2),
        ),
      ).toBe(true);
      await userEvent.click(reload);
      expect(retryStaleChunkReloadWhenReachable).toHaveBeenCalledOnce();
    } finally {
      view.dispose();
      transcript.dispose();
      ready.mockRestore();
      load.mockRestore();
    }
  });

  it.each(["work", "activity", "tool", "tool-output", "raw"] as const)(
    "toggles on rapid clicks without selecting labels and retains keyboard access (%s)",
    async (kind) => {
      container = document.body.appendChild(document.createElement("div"));
      const groups = [
        group("activity", {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "search",
              name: "web_search",
              arguments: { query: "disclosures" },
            },
          ],
          activity: [
            {
              itemId: "search",
              toolCallId: "search",
              kind: "tool",
              phase: "end",
              name: "web_search",
              title: "Search",
              status: "completed",
            },
          ],
        }),
      ];
      const output = group("output", {
        role: "toolResult",
        toolCallId: "search",
        toolName: "web_search",
        content: "Search results",
      });
      let expanded = false;
      const toggle = () => {
        expanded = !expanded;
        draw();
      };
      function Disclosure(props: { expanded: boolean }) {
        const options = () => ({
          showToolCalls: true,
          showReasoning: false,
          isToolMessageExpanded: () => props.expanded,
          onToggleToolMessageExpanded: toggle,
        });
        return (
          <>
            {kind === "work" ? (
              <WorkGroupSummary
                item={{ key: "work", durationMs: null, groups }}
                options={{ expanded: props.expanded, onToggle: toggle }}
              />
            ) : kind === "activity" ? (
              <ActivityGroup groups={groups} options={options()} presentation="standalone" />
            ) : kind === "tool" ? (
              <ChatToolCard
                card={{
                  id: "search",
                  name: "web_search",
                  args: { query: "disclosures" },
                  completed: true,
                }}
                options={{ messageKey: "tool", expanded: props.expanded, onToggleExpanded: toggle }}
              />
            ) : kind === "tool-output" ? (
              <MessageGroup group={output} options={options()} />
            ) : (
              <openclaw-chat-tool-raw>
                <RawOutputToggle text="Copyable output" />
              </openclaw-chat-tool-raw>
            )}
          </>
        );
      }
      const view = mountSolid(Disclosure, { expanded }, container);
      const draw = () => view.update({ expanded });
      draw();
      await settleToolBridges(container);
      const button = container.querySelector<HTMLButtonElement>(".chat-inline-disclosure")!;
      const label = (button.querySelector<HTMLElement>(
        ".chat-activity-group__label, .chat-tool-msg-summary__label, .chat-tool-msg-summary__names",
      ) ?? button.querySelector<HTMLElement>("span"))!;
      expect(button.getAttribute("aria-expanded")).toBe("false");
      // Real pointer events exercise browser word selection before the second click.
      await userEvent.dblClick(label);
      expect(window.getSelection()?.toString()).toBe("");
      expect(button.getAttribute("aria-expanded")).toBe("false");
      await userEvent.click(label);
      expect(button.getAttribute("aria-expanded")).toBe("true");
      await userEvent.keyboard("{Enter}");
      expect(button.getAttribute("aria-expanded")).toBe("false");
      await userEvent.keyboard(" ");
      expect(button.getAttribute("aria-expanded")).toBe("true");
      expect(document.activeElement).toBe(button);
      expect(button.matches(":focus-visible")).toBe(true);
    },
  );

  it("dims live operation text until hover or keyboard focus without a tooltip", async () => {
    container = document.body.appendChild(document.createElement("div"));
    const view = mountView(
      () => (
        <ContentPresentation value={() => true}>
          <button class="chat-inline-disclosure chat-activity-group__summary">
            <ChatActivityHeadline
              scope="hover-proof"
              activity={{
                key: "search",
                name: "tool_search",
                title: "Find available tools",
                status: "running",
              }}
              summary="5 other operations"
            />
          </button>
        </ContentPresentation>
      ),
      { container },
    );
    try {
      const button = container.querySelector<HTMLButtonElement>("button")!;
      const label = container.querySelector<HTMLElement>(".chat-activity-group__label")!;
      const icon = container.querySelector<HTMLElement>(".chat-activity-group__icon")!;
      // Isolate the state assertions from the production color transition.
      button.style.transition = "none";
      await userEvent.hover(document.body, { position: { x: 0, y: 0 } });
      const resting = getComputedStyle(label).color;
      expect(resting).toBe(getComputedStyle(button).color);
      expect(icon.getAttribute("aria-label")).toBe("tool_search");
      expect(button.querySelector("[title]")).toBeNull();
      await userEvent.hover(icon);
      const hovered = getComputedStyle(label).color;
      expect(hovered).not.toBe(resting);
      expect(hovered).toBe(getComputedStyle(button).color);
      await userEvent.hover(document.body, { position: { x: 0, y: 0 } });
      expect(getComputedStyle(label).color).toBe(resting);
      await userEvent.tab();
      expect(document.activeElement).toBe(button);
      expect(button.matches(":focus-visible")).toBe(true);
      expect(getComputedStyle(label).color).toBe(hovered);
    } finally {
      view.unmount();
    }
  });

  it("keeps message prose and expanded output selectable", async () => {
    container = document.body.appendChild(document.createElement("div"));
    mountView(
      () => (
        <>
          <MessageGroup
            group={group(
              "answer",
              { role: "assistant", content: "Copyable explanation." },
              "assistant",
            )}
            options={{ showReasoning: false }}
          />
          <openclaw-chat-tool-raw>
            <RawOutputToggle text="Copyable output" />
          </openclaw-chat-tool-raw>
        </>
      ),
      { container },
    );
    await settleToolBridges(container);
    const prose = container.querySelector<HTMLElement>(".chat-text p")!;
    await userEvent.dblClick(prose);
    expect(window.getSelection()?.toString()).not.toBe("");
    window.getSelection()?.removeAllRanges();
    await userEvent.click(
      container.querySelector<HTMLButtonElement>(".chat-tool-card__raw-toggle")!,
    );
    await userEvent.dblClick(
      container.querySelector<HTMLElement>(".chat-tool-card__raw-body code")!,
    );
    expect(window.getSelection()?.toString()).not.toBe("");
  });
});
