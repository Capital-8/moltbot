import { createHash } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Locator, Page } from "playwright";
import { expect } from "vitest";
import { waitForChatScrollIdle } from "./chat-flow.test-support.ts";
import {
  sampleHistoryAnchor,
  type AnchorWindow,
} from "./chat-history-pagination-probe.test-support.ts";

// Keep real Gateway bytes/cursors intact; only delivery waits for settled reader input.
export async function installHistoryResponseGate(page: Page, sessionKey: string) {
  let armed = false;
  const replies: Array<{ deliver: () => void; id: string; cursor: string; sha256: string }> = [];
  const released: Array<{ id: string; cursor: string; sha256: string }> = [];
  await page.routeWebSocket(/\/.*$/u, (socket) => {
    const server = socket.connectToServer();
    const requests = new Map<string, string>();
    socket.onMessage((message) => {
      const frame: unknown = JSON.parse(message.toString());
      if (
        armed &&
        isRecord(frame) &&
        frame.method === "chat.history" &&
        typeof frame.id === "string" &&
        isRecord(frame.params) &&
        frame.params.sessionKey === sessionKey &&
        typeof frame.params.cursor === "string"
      ) {
        requests.set(frame.id, frame.params.cursor);
      }
      server.send(message);
    });
    server.onMessage((message) => {
      const frame: unknown = JSON.parse(message.toString());
      const id = isRecord(frame) && typeof frame.id === "string" ? frame.id : undefined;
      const cursor = id && requests.get(id);
      if (id && cursor && armed) {
        requests.delete(id);
        replies.push({
          id,
          cursor,
          sha256: createHash("sha256").update(message).digest("hex"),
          deliver: () => socket.send(message),
        });
      } else {
        if (id) {
          requests.delete(id);
        }
        socket.send(message);
      }
    });
  });
  return {
    arm: () => {
      armed = true;
    },
    wait: () => expect.poll(() => replies.length).toBeGreaterThan(0),
    release: () => {
      const reply = replies.shift();
      if (!reply) {
        throw new Error("No actual history response is held");
      }
      reply.deliver();
      released.push({ id: reply.id, cursor: reply.cursor, sha256: reply.sha256 });
    },
    disarm: () => {
      armed = false;
      for (const reply of replies.splice(0)) {
        reply.deliver();
      }
    },
    released,
  };
}

export async function sampleControlledHistoryAdmission(
  page: Page,
  bubble: Locator,
  readerCalibration: boolean,
) {
  await waitForChatScrollIdle(page);
  const probe = await sampleHistoryAnchor(bubble);
  let readerMotion = 0;
  if (readerCalibration) {
    // No response is admitted during this phase. Normalize observed reader motion
    // only, then freeze that correction before admission can produce scroll writes.
    const motion = await bubble.evaluateHandle((element) => {
      const thread = element.closest<HTMLElement>(".chat-thread")!;
      const pane = element.closest<HTMLElement>("openclaw-chat-pane") as HTMLElement & {
        state: { chatIsProgrammaticScroll: () => boolean; chatIsMaintenanceScroll: () => boolean };
      };
      let prior = thread.scrollTop;
      let invalid = false;
      let delta = 0;
      const onScroll = () => {
        invalid ||= pane.state.chatIsProgrammaticScroll() || pane.state.chatIsMaintenanceScroll();
        const consumed = thread.scrollTop - prior;
        prior = thread.scrollTop;
        delta += consumed;
        (window as AnchorWindow).prependFrames.readerDelta += consumed;
      };
      thread.addEventListener("scroll", onScroll);
      return () => {
        thread.removeEventListener("scroll", onScroll);
        return { invalid, delta };
      };
    });
    await page.mouse.wheel(0, 40);
    await waitForChatScrollIdle(page);
    const result = await motion.evaluate((stop) => stop());
    await motion.dispose();
    expect(result.invalid, "calibration contains reader motion only").toBe(false);
    expect(result.delta).toBeGreaterThan(0);
    readerMotion = result.delta;
  }
  return async () => {
    await waitForChatScrollIdle(page);
    const positions = await probe.evaluate((stop) => stop());
    await probe.dispose();
    const initial = positions[0];
    expect(initial).not.toBeNull();
    expect(positions.length).toBeGreaterThan(1);
    const maxDrift = Math.max(
      ...positions.map((top) => (top === null ? Infinity : Math.abs(top - initial!))),
    );
    return { positions, frames: positions.length, maxDrift, readerMotion };
  };
}

export async function detectNonInputHistoryShift(page: Page, bubble: Locator) {
  const probe = await sampleHistoryAnchor(bubble);
  const before = await bubble.evaluate((element: HTMLElement) => {
    const prior = element.style.transform;
    element.style.transform = "translateY(12px)";
    return prior;
  });
  try {
    await page.evaluate(async () => {
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    });
  } finally {
    await bubble.evaluate((element: HTMLElement, prior) => {
      element.style.transform = prior;
    }, before);
  }
  const positions = await probe.evaluate((stop) => stop());
  await probe.dispose();
  expect(positions.every((top) => top !== null)).toBe(true);
  const maxDrift = Math.max(...positions.map((top) => Math.abs(top! - positions[0]!)));
  expect(maxDrift, "non-input shift must fail the placement oracle").toBeGreaterThan(2);
  return { positions, maxDrift };
}
