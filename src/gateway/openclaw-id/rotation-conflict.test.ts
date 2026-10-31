// Spec section 8 / 11 #9 (OCF-277): a second, different root rotation out of an epoch
// that already rotated is refused, but the claw freezes remote root changes and alerts
// its owners. The freeze is persisted, survives a Gateway restart, and the alert is
// delivered whether the conflict arrives over the mailbox or directly.
import { describe, expect, it, vi } from "vitest";
import {
  fingerprint,
  formatEd25519PublicKey,
  generateEd25519Signer,
  signStatement,
  type AuthorityEvent,
  type MailboxMessage,
  type StatementSigner,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import { createOpenClawIdAuthority } from "./authority.js";
import type { DiscoveryClient } from "./discovery-client.js";
import { startMailboxReader } from "./mailbox-reader.js";
import { linkedClaw, memoryStore, nowSeconds, serviceFor } from "./openclaw-id.test-support.js";

const notices = vi.hoisted(() => ({ sent: [] as AuthorityEvent[][] }));
vi.mock("./owner-notices.js", () => ({
  sendOwnerNotices: async (params: { events: AuthorityEvent[] }) => {
    notices.sent.push([...params.events]);
  },
}));

const CONFLICT_NOTICE = { type: "notify_owners", event: "rotation_conflict", ref: "2" };

// RootRotation from `from` (the root of epoch `epoch - 1`) to a new key.
async function rotation(from: StatementSigner, epoch: number) {
  const to = await generateEd25519Signer();
  const statement = await signStatement(
    "RootRotation",
    {
      old_root_fp: await fingerprint(formatEd25519PublicKey(from.publicKey)),
      new_root_pub: formatEd25519PublicKey(to.publicKey),
      new_epoch: epoch,
      issued_at: nowSeconds(),
    },
    from,
  );
  return { statement, to };
}

// A linked claw whose root R already rotated to A (epoch 2), and R's conflicting rotation to B.
async function rotatedClaw() {
  const store = memoryStore();
  const claw = await linkedClaw(store);
  const first = await rotation(claw.root, 2);
  expect(await claw.authority.submit(first.statement, "mailbox")).toMatchObject({ ok: true });
  const conflicting = await rotation(claw.root, 2);
  return { claw, store, rootA: first.to, conflicting: conflicting.statement };
}

function rootMail(clawId: string, statements: unknown[]): MailboxMessage {
  return {
    message_id: "m-rotation",
    claw_id: clawId,
    to: "gateway",
    from: {
      account_id: "acct_attacker",
      email: null,
      display_name: null,
      device_fp: null,
      reported_by: "openclaw-id",
    },
    location_hint: null,
    payload: { kind: "root_statement", statements },
    received_at: nowSeconds(),
    expires_at: nowSeconds() + 86400,
  } as MailboxMessage;
}

describe("OpenClaw ID conflicting root rotations (spec 11 #9)", () => {
  it("persists the freeze on refusal and keeps it across a restart", async () => {
    const { claw, store, rootA, conflicting } = await rotatedClaw();
    const refused = await claw.authority.submit(conflicting, "mailbox");
    expect(refused).toMatchObject({ ok: false, code: "conflicting_rotation" });
    expect(refused.ok ? [] : refused.events).toContainEqual(CONFLICT_NOTICE);
    expect((await store.read())?.authority?.frozen).toBe(true);

    // A fresh authority over the same record is what a restarted Gateway loads.
    const restarted = createOpenClawIdAuthority(store);
    expect((await restarted.load())?.authority?.frozen).toBe(true);
    const next = await rotation(rootA, 3);
    expect(await restarted.submit(next.statement, "mailbox")).toMatchObject({
      ok: false,
      code: "frozen",
    });
    expect(await restarted.submit(next.statement, "tunnel")).toMatchObject({
      ok: false,
      code: "frozen",
    });
    expect((await restarted.load())?.authority?.anchor.root_epoch).toBe(2);
  });

  it("delivers the owner alert for a conflict sent directly, without accepting it", async () => {
    const { claw, conflicting } = await rotatedClaw();
    const { service } = serviceFor(claw.authority);
    notices.sent = [];
    const result = await service.submitStatement("tunnel", conflicting);
    expect(result).toMatchObject({ ok: false, code: "conflicting_rotation" });
    // Notices are mailed in the background after the write returns.
    await vi.waitFor(() => expect(notices.sent.flat()).toContainEqual(CONFLICT_NOTICE));
  });

  it("delivers the owner alert for a conflict read from the mailbox", async () => {
    const { claw, conflicting } = await rotatedClaw();
    const effects: AuthorityEvent[][] = [];
    let delivered = false;
    const client = {
      receiveMail: vi.fn(async () => {
        if (delivered) {
          return await new Promise<never>(() => {});
        }
        delivered = true;
        return { messages: [rootMail(claw.clawId, [conflicting])], cursor: "c1" };
      }),
      ackMail: vi.fn(async () => {}),
    } as unknown as DiscoveryClient;
    const reader = startMailboxReader({
      clawId: claw.clawId,
      client,
      cursor: null,
      sink: {
        submit: (statement) => claw.authority.submit(statement, "mailbox"),
        redeem: async () => ({ ok: false, code: "unsupported", detail: "" }),
        saveCursor: async () => {},
      },
      onEffects: async (events) => {
        effects.push(events);
      },
      log: { info: vi.fn(), warn: vi.fn() },
    });
    await vi.waitFor(() => expect(client.ackMail).toHaveBeenCalled());
    reader.stop();
    expect(effects.flat()).toContainEqual(CONFLICT_NOTICE);
    expect((await claw.authority.load())?.authority?.frozen).toBe(true);
  });
});
