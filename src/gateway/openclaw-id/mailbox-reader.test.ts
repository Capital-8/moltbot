import { afterEach, describe, expect, it, vi } from "vitest";
import type { MailboxMessage } from "../../../packages/openclaw-id-protocol/src/index.js";
import { startMailboxReader } from "./mailbox-reader.js";

const rootMail: MailboxMessage = {
  message_id: "m1",
  claw_id: "c1",
  to: "gateway",
  from: {
    account_id: "a",
    email: null,
    display_name: null,
    device_fp: "fp:dev",
    reported_by: "openclaw-id",
  },
  location_hint: null,
  payload: { kind: "root_statement", statements: [{} as never] },
  received_at: 0,
  expires_at: 0,
};

describe("mailbox reader callbacks", () => {
  let reader: { stop(): void } | undefined;
  afterEach(() => {
    reader?.stop();
    vi.useRealTimers();
  });

  it("reports the first read and each recovery as connected, and refusals with their message", async () => {
    vi.useFakeTimers();
    const replies: Array<() => Promise<unknown>> = [
      async () => ({ messages: [], cursor: "1" }),
      async () => {
        throw new TypeError("fetch failed");
      },
      async () => ({ messages: [rootMail], cursor: "2" }),
    ];
    const client = {
      receiveMail: vi.fn(async () =>
        replies.length > 0 ? await replies.shift()!() : await new Promise(() => {}),
      ),
      ackMail: vi.fn(async () => {}),
    };
    const onConnected = vi.fn();
    const onRefused = vi.fn(async () => {});
    reader = startMailboxReader({
      clawId: "c1",
      client: client as never,
      cursor: null,
      sink: {
        submit: async () => ({ ok: false, code: "seq_conflict", detail: "expected seq 3" }),
        redeem: vi.fn(),
        saveCursor: async () => {},
      },
      onEffects: async () => {},
      onRefused,
      onConnected,
      log: { info: vi.fn(), warn: vi.fn() },
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onConnected).toHaveBeenCalledTimes(2);
    expect(onRefused).toHaveBeenCalledWith(rootMail, {
      ok: false,
      code: "seq_conflict",
      detail: "expected seq 3",
    });
    expect(client.ackMail).toHaveBeenCalledWith("c1", "2");
  });
});
