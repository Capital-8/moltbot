/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import { saveChatSessionScrollPosition } from "../scroll.ts";
import { render, renderChatThread } from "../test-helpers/chat-transcript-native.tsx";
import { chatRichPresentation } from "./chat-rich-presentation.ts";
import { threadFixture, transcriptContainer } from "./chat-transcript-fixture.test-support.tsx";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  transcriptRows,
  threadProps,
} from "./chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

function delayedRichPresentation() {
  const pending = Promise.withResolvers<void>();
  const load = chatRichPresentation.load;
  let ready = false;
  vi.spyOn(chatRichPresentation, "ready").mockImplementation(() => ready);
  vi.spyOn(chatRichPresentation, "load").mockImplementation(async () => {
    await pending.promise;
    const result = await load();
    ready = true;
    return result;
  });
  return pending;
}

function mixedHistory() {
  return Array.from({ length: 80 }, (_, index) => ({
    role: index % 2 ? "user" : "assistant",
    content:
      index === 0
        ? "Earlier rich answer\nMEDIA:https://example.com/proof.png"
        : `Plain history ${index}`,
    timestamp: 1_000 + index,
    __openclaw: { id: `mixed-${index}`, seq: index + 1 },
  }));
}

it.each(["scroll", "reveal"] as const)(
  "defers offscreen rich history until its row is needed by %s",
  async (navigation) => {
    const pending = delayedRichPresentation();
    const view = threadFixture(threadProps("mixed-rich-history", undefined, mixedHistory()));
    try {
      view.rerender();
      const scroller = view.transcript.scrollElement!;
      // This fixture follows real offsets during initial end placement and later navigation.
      scroller.scrollTo = (options?: ScrollToOptions | number) => {
        if (typeof options === "object") {
          scroller.scrollTop = options.top ?? scroller.scrollTop;
          scroller.dispatchEvent(new Event("scroll"));
        }
      };
      await waitForSolid(() => expect(view.container.textContent).toContain("Plain history 79"));
      await waitForSolid(() =>
        expect(
          view.container.querySelector<HTMLDivElement>(".chat-thread-inner")!.style.visibility,
        ).not.toBe("hidden"),
      );
      expect(chatRichPresentation.load).not.toHaveBeenCalled();
      expect(view.container.querySelector(".chat-transcript-preparation")).toBeNull();
      const acceptedRows = transcriptRows(view.container);
      if (navigation === "reveal") {
        expect(view.transcript.revealMessage("mixed-0")).toBe(true);
      } else {
        scroller.scrollTop = 0;
        scroller.dispatchEvent(new Event("scroll"));
      }
      view.rerender();
      view.transcript.update();
      flush();
      await waitForSolid(() => expect(chatRichPresentation.load).toHaveBeenCalledOnce());
      expect(view.container.textContent).not.toContain("Earlier rich answer");
      expect(transcriptRows(view.container)).toEqual(acceptedRows);
      expect(view.container.querySelector(".chat-transcript-preparation")).not.toBeNull();

      pending.resolve();
      await waitForSolid(() => expect(view.container.textContent).toContain("Earlier rich answer"));
      expect(view.container.querySelector(".chat-transcript-preparation")).toBeNull();
    } finally {
      render(null, view.container);
      view.transcript.dispose();
    }
  },
);

it("prepares a rich row at the saved reading offset before admitting its range", async () => {
  const pending = delayedRichPresentation();
  const props = threadProps("saved-rich-history", "agent:main:saved-rich", mixedHistory());
  saveChatSessionScrollPosition(props.paneId, props.sessionKey, {
    scrollTop: 0,
    anchorToEnd: false,
  });
  const transcript = createTestTranscript(props.paneId);
  const container = transcriptContainer();
  try {
    render(renderChatThread(props, transcript), container);
    flush();
    expect(chatRichPresentation.load).toHaveBeenCalledOnce();
    expect(transcriptRows(container)).toHaveLength(0);
    expect(container.querySelector(".chat-transcript-preparation")).not.toBeNull();
    pending.resolve();
    await waitForSolid(() => expect(container.textContent).toContain("Earlier rich answer"));
    expect(container.querySelector(".chat-transcript-preparation")).toBeNull();
  } finally {
    render(null, container);
    transcript.dispose();
  }
});

it("keeps initial rows hidden while preparing rich content and reveals failed recovery", async () => {
  const pending = delayedRichPresentation();
  const view = threadFixture(
    threadProps("measured-rich-history", undefined, [
      {
        role: "assistant",
        content: "Earlier measured image\nMEDIA:https://example.com/proof.png",
        timestamp: 1_000,
      },
      { role: "user", content: "Visible plain tail", timestamp: 2_000 },
    ]),
  );
  try {
    view.rerender();
    expect(chatRichPresentation.load).toHaveBeenCalledOnce();
    expect(view.container.textContent).toContain("Visible plain tail");
    expect(view.container.querySelector(".chat-transcript-preparation")).toBeNull();
    const tail = view.container.querySelector(".chat-group.user");
    await waitForSolid(() =>
      expect(view.container.querySelector(".chat-transcript-preparation")).not.toBeNull(),
    );
    expect(view.container.textContent).not.toContain("Earlier measured image");
    expect(view.container.querySelector(".chat-group.user")).toBe(tail);
    const inner = view.container.querySelector<HTMLDivElement>(".chat-thread-inner")!;
    expect(inner.style.visibility).toBe("hidden");
    pending.reject(new Error("Measured rich presentation unavailable"));
    await waitForSolid(() =>
      expect(view.container.textContent).toContain("Measured rich presentation unavailable"),
    );
    expect(inner.style.visibility).not.toBe("hidden");
    expect(view.container.querySelector(".chat-transcript-preparation")?.textContent).toContain(
      "Reload",
    );
  } finally {
    render(null, view.container);
    view.transcript.dispose();
  }
});

it.each([
  ["plain text", "Immediate cached answer"],
  [
    "a canvas preview",
    'Immediate cached answer\n\n[embed ref="team-scale-chart-12" title="Team metric 12" height="220" /]',
  ],
])("renders %s without requesting the optional family", (_label, content) => {
  vi.spyOn(chatRichPresentation, "ready").mockReturnValue(false);
  const load = vi.spyOn(chatRichPresentation, "load");
  const view = threadFixture(
    threadProps("plain-rich-admission", "agent:main:plain", [
      { role: "assistant", content, timestamp: 1_000 },
    ]),
  );
  try {
    view.rerender();
    expect(view.container.textContent).toContain("Immediate cached answer");
    expect(load).not.toHaveBeenCalled();
  } finally {
    render(null, view.container);
    view.transcript.dispose();
  }
});

it.each(["loaded", "failed"] as const)(
  "retains accepted rows and focus while rich presentation is %s",
  async (outcome) => {
    const pending = delayedRichPresentation();
    const user = { role: "user", content: "Keep this question", timestamp: 1_000 };
    const props = threadProps("retained-rich-admission", "agent:main:retained", [
      user,
      { role: "assistant", content: "Previous answer", timestamp: 2_000 },
    ]);
    props.onSetReply = () => {};
    const view = threadFixture(props);
    try {
      view.rerender();
      await waitForSolid(() =>
        expect(view.container.querySelector(".chat-group.user")).not.toBeNull(),
      );
      const question = view.container.querySelector(".chat-group.user");
      const reply = view.container.querySelector<HTMLButtonElement>(
        'button[aria-label="Reply to message"]',
      );
      expect(reply).not.toBeNull();
      reply!.focus();
      const rowKeys = () =>
        [...view.container.querySelectorAll("[data-virtual-row-key]")].map((row) =>
          row.getAttribute("data-virtual-row-key"),
        );
      const acceptedKeys = rowKeys();
      props.messages = [
        user,
        {
          role: "assistant",
          content: "Replacement answer\nMEDIA:https://example.com/proof.png",
          timestamp: 2_000,
        },
      ];
      view.rerender();
      view.transcript.update();
      flush();
      expect(view.container.textContent).toContain("Previous answer");
      expect(view.container.textContent).not.toContain("Replacement answer");
      expect(view.container.querySelector(".chat-group.user")).toBe(question);
      expect(rowKeys()).toEqual(acceptedKeys);
      expect(document.activeElement).toBe(reply);
      expect(view.container.querySelector(".chat-transcript-preparation")).not.toBeNull();

      if (outcome === "loaded") {
        pending.resolve();
        await waitForSolid(() =>
          expect(view.container.textContent).toContain("Replacement answer"),
        );
        expect(view.container.textContent).not.toContain("Previous answer");
        expect(view.container.querySelector(".chat-transcript-preparation")).toBeNull();
        expect(view.container.querySelector(".chat-group.user")).toBe(question);
        expect(document.activeElement).toBe(reply);
      } else {
        pending.reject(new Error("Rich presentation unavailable"));
        await waitForSolid(() =>
          expect(view.container.textContent).toContain("Rich presentation unavailable"),
        );
        expect(view.container.textContent).toContain("Previous answer");
        expect(view.container.textContent).not.toContain("Replacement answer");
        expect(view.container.querySelector(".chat-transcript-preparation")?.textContent).toContain(
          "Reload",
        );
        expect(document.activeElement).toBe(reply);
      }
    } finally {
      render(null, view.container);
      view.transcript.dispose();
    }
  },
);

it("prepares completed keyed preamble media before replacing accepted plain rows", () => {
  delayedRichPresentation();
  const props = threadProps("preamble-rich-admission", "agent:main:preamble", [
    { role: "user", content: "Keep this question", timestamp: 1_000 },
    { role: "assistant", content: "Accepted plain answer", timestamp: 2_000 },
  ]);
  const view = threadFixture(props);
  try {
    view.rerender();
    const acceptedRows = [...view.container.querySelectorAll("[data-virtual-row-key]")];
    expect(acceptedRows.length).toBeGreaterThan(0);
    expect(view.container.textContent).toContain("Accepted plain answer");
    expect(chatRichPresentation.load).not.toHaveBeenCalled();

    // Completed preamble events publish keyed segments without a live text stream.
    props.streamSegments = [
      {
        itemId: "chart-preamble",
        runId: "preamble-run",
        ts: 3_000,
        text: "Here is the chart.\nMEDIA:https://example.com/chart.png",
      },
    ];
    view.rerender();
    view.transcript.update();
    flush();

    expect(chatRichPresentation.load).toHaveBeenCalledOnce();
    expect(view.container.querySelector(".chat-transcript-preparation")).not.toBeNull();
    expect(view.container.textContent).toContain("Accepted plain answer");
    expect(view.container.textContent).not.toContain("Here is the chart.");
    const currentRows = view.container.querySelectorAll("[data-virtual-row-key]");
    expect(currentRows.length).toBe(acceptedRows.length);
    acceptedRows.forEach((row, index) => expect(currentRows[index]).toBe(row));
  } finally {
    render(null, view.container);
    view.transcript.dispose();
  }
});

it("holds the mounted stream at its admitted text until its first rich block is ready", async () => {
  const pending = delayedRichPresentation();
  const props = threadProps("stream-rich-admission", "agent:main:stream", [], {
    stream: "Current streamed answer",
    streamStartedAt: 1_000,
    runActive: true,
  });
  const view = threadFixture(props);
  try {
    view.rerender();
    const bubble = view.container.querySelector(".chat-bubble.streaming");
    expect(bubble?.textContent).toContain("Current streamed answer");
    props.stream = "Rich streamed answer\nMEDIA:https://example.com/stream.png";
    view.rerender();
    view.transcript.update();
    flush();
    expect(view.container.querySelector(".chat-bubble.streaming")).toBe(bubble);
    expect(bubble?.textContent).toContain("Current streamed answer");
    expect(bubble?.textContent).not.toContain("Rich streamed answer");
    props.stream = "Latest streamed answer\nMEDIA:https://example.com/stream.png";
    view.rerender();
    view.transcript.update();
    flush();
    pending.resolve();
    await waitForSolid(() => expect(bubble?.textContent).toContain("Latest streamed answer"));
    expect(view.container.querySelector(".chat-bubble.streaming")).toBe(bubble);
    expect(bubble?.textContent).not.toContain("Rich streamed answer");
  } finally {
    render(null, view.container);
    view.transcript.dispose();
  }
});
