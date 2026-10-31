import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatEd25519PublicKey,
  formatIrohEndpointKey,
  generateEd25519Signer,
  OWNER_CAPABILITIES,
  randomBytes,
  signStatement,
  type SignedStatement,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import { DiscoveryRequestError } from "./discovery-client.js";
import { linkedClaw, nowSeconds, type LinkedClaw } from "./openclaw-id.test-support.js";
import {
  createPublicationRetry,
  PUBLICATION_RETRY_INITIAL_MS,
  PUBLICATION_RETRY_MAX_MS,
  publicationPending,
} from "./publication-retry.js";
import { publishClaw, type PublishOutcome } from "./publisher.js";

const log = () => ({ info: vi.fn(), warn: vi.fn() });

// A Discovery mirror that keeps the last snapshot seq and fails the calls it is told to.
function fakeDiscovery() {
  const failures: Array<{ call: "descriptor" | "snapshot"; error: Error }> = [];
  const mirror = { snapshotSeq: 1, descriptors: 0 };
  const take = (call: "descriptor" | "snapshot") => {
    const index = failures.findIndex((failure) => failure.call === call);
    const [failure] = index >= 0 ? failures.splice(index, 1) : [];
    if (failure) {
      throw failure.error;
    }
  };
  const client = {
    registerClaw: vi.fn(),
    publishDescriptor: vi.fn(async () => {
      take("descriptor");
      mirror.descriptors += 1;
    }),
    publishSnapshot: vi.fn(
      async (_clawId: string, snapshot: SignedStatement<"MembershipSnapshot">) => {
        take("snapshot");
        mirror.snapshotSeq = snapshot.body.seq;
      },
    ),
  };
  return {
    client,
    mirror,
    fail: (call: "descriptor" | "snapshot", error: Error) => failures.push({ call, error }),
  };
}

// A linked, registered claw whose seq-1 state Discovery already has, wired to a retrier.
async function registeredClaw() {
  const claw = await linkedClaw();
  await claw.authority.recordDiscovery({
    owner_account_id: "acct-owner",
    published_binding_seq: 1,
    published_snapshot_seq: 1,
  });
  const discovery = fakeDiscovery();
  const signer = await generateEd25519Signer();
  const outcomes: PublishOutcome[] = [];
  // The attempt in flight; timer-fired retries are awaited through it (signing is real crypto).
  let inflight: Promise<unknown> = Promise.resolve();
  const attempt = async () => {
    const record = claw.authority.current()!;
    const outcome = await publishClaw({
      record,
      relayUrl: "https://relay.example.test/",
      client: discovery.client as never,
      signer,
    });
    outcomes.push(outcome);
    if (outcome.state === "published") {
      await claw.authority.recordDiscovery({
        published_binding_seq: record.binding!.body.binding_seq,
        published_snapshot_seq: outcome.snapshotSeq,
      });
    }
    return outcome;
  };
  const publish = () => {
    const run = attempt();
    inflight = run;
    return run;
  };
  // Fires due retry timers and waits until the attempts they start have settled.
  const advance = async (ms: number) => {
    await vi.advanceTimersByTimeAsync(ms);
    await inflight;
    await vi.advanceTimersByTimeAsync(0);
  };
  const logger = log();
  const retry = createPublicationRetry({
    publish,
    current: () => claw.authority.current(),
    setPending: (pending) => claw.authority.recordDiscovery({ publish_pending: pending }),
    log: logger,
    random: () => 1,
  });
  return { claw, discovery, retry, outcomes, logger, advance };
}

// What a browser with the recovery kit mails: R signs add_owner_device at the mirror's seq + 1.
async function kitEnrollment(claw: LinkedClaw, mirrorSeq: number) {
  const device = await generateEd25519Signer();
  const cert = await signStatement(
    "OwnerDeviceCert",
    {
      device_pub: formatEd25519PublicKey(device.publicKey),
      peer_keys: [formatIrohEndpointKey(randomBytes(32))],
      label: "laptop",
      scope: "owner",
      caps: [...OWNER_CAPABILITIES],
      issued_at: nowSeconds(),
      expires_at: null,
      root_epoch: 1,
    },
    claw.root,
  );
  return await signStatement(
    "MembershipChange",
    {
      claw_id: claw.clawId,
      seq: mirrorSeq + 1,
      target: { op: "add_owner_device", cert },
      issued_at: nowSeconds(),
    },
    claw.root,
  );
}

describe("publication retry (OCF-313)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("recovers from one failed publish with no manual step, so the next kit enrollment succeeds", async () => {
    const { claw, discovery, retry, advance } = await registeredClaw();
    await retry.start();
    // A membership change (kit enrollment #1) is accepted at seq 2 ...
    const first = await claw.authority.submit(await kitEnrollment(claw, 1), "mailbox");
    expect(first.ok).toBe(true);
    // ... and its publication hits a Discovery outage.
    discovery.fail("snapshot", new TypeError("fetch failed"));
    await retry.request();
    expect(discovery.mirror.snapshotSeq).toBe(1);
    expect(publicationPending(claw.authority.current())).toBe(true);
    expect(claw.authority.current()?.discovery.publish_pending).toBe(true);
    expect(retry.nextRetryAt()).toBeDefined();

    // Discovery is back; the scheduled retry catches the mirror up on its own.
    await advance(PUBLICATION_RETRY_INITIAL_MS);
    expect(discovery.mirror.snapshotSeq).toBe(2);
    expect(publicationPending(claw.authority.current())).toBe(false);
    expect(retry.nextRetryAt()).toBeUndefined();

    // A second browser signs at the mirror's seq + 1 and is accepted.
    const second = await claw.authority.submit(
      await kitEnrollment(claw, discovery.mirror.snapshotSeq),
      "mailbox",
    );
    expect(second.ok).toBe(true);
  });

  it("without the retry, the same outage leaves the next kit enrollment refused as seq_conflict", async () => {
    const { claw, discovery, retry, advance } = await registeredClaw();
    // Retries disabled (not started): one attempt only, as before OCF-313.
    await claw.authority.submit(await kitEnrollment(claw, 1), "mailbox");
    discovery.fail("snapshot", new TypeError("fetch failed"));
    await retry.request();
    await advance(PUBLICATION_RETRY_MAX_MS);
    expect(discovery.mirror.snapshotSeq).toBe(1);
    const refused = await claw.authority.submit(await kitEnrollment(claw, 1), "mailbox");
    expect(refused).toMatchObject({ ok: false, code: "seq_conflict" });
  });

  it("backs off exponentially up to the cap and keeps retrying until Discovery answers", async () => {
    const { claw, discovery, retry, outcomes, advance } = await registeredClaw();
    await retry.start();
    await claw.authority.submit(await kitEnrollment(claw, 1), "mailbox");
    for (let i = 0; i < 12; i++) {
      discovery.fail(
        "snapshot",
        new DiscoveryRequestError(503, "unavailable", "temporary failure"),
      );
    }
    const delays: number[] = [];
    await retry.request();
    for (let i = 0; i < 20 && outcomes.at(-1)?.state !== "published"; i++) {
      const at = retry.nextRetryAt();
      expect(at).toBeDefined();
      delays.push(at! - Date.now());
      await advance(at! - Date.now());
    }
    expect(delays.slice(0, 4)).toEqual([2_000, 4_000, 8_000, 16_000]);
    expect(Math.max(...delays)).toBe(PUBLICATION_RETRY_MAX_MS);
    expect(outcomes).toHaveLength(13);
    expect(discovery.mirror.snapshotSeq).toBe(2);
  });

  it("does not retry a refusal that will not change (4xx), but keeps it pending for the next start", async () => {
    const { claw, discovery, retry, logger } = await registeredClaw();
    await retry.start();
    await claw.authority.submit(await kitEnrollment(claw, 1), "mailbox");
    discovery.fail("snapshot", new DiscoveryRequestError(400, "bad_request", "invalid snapshot"));
    await retry.request();
    expect(retry.nextRetryAt()).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("refused (bad_request)"));
    expect(publicationPending(claw.authority.current())).toBe(true);
    retry.stop();
    await retry.start();
    expect(discovery.mirror.snapshotSeq).toBe(2);
    expect(publicationPending(claw.authority.current())).toBe(false);
  });

  it("resumes a pending publication at startup (after a restart) and on reconnect, with the backoff reset", async () => {
    const { claw, discovery, retry } = await registeredClaw();
    await claw.authority.submit(await kitEnrollment(claw, 1), "mailbox");
    // Durable: the record says seq 2 was never published.
    expect(publicationPending(claw.authority.current())).toBe(true);
    discovery.fail("snapshot", new TypeError("fetch failed"));
    await retry.start();
    expect(retry.nextRetryAt()).toBeDefined();
    // The mailbox reconnects before the timer fires: publish now.
    await retry.resume();
    expect(discovery.mirror.snapshotSeq).toBe(2);
    expect(retry.nextRetryAt()).toBeUndefined();
  });

  it("stops scheduling retries on stop; the pending flag survives", async () => {
    const { claw, discovery, retry, outcomes, advance } = await registeredClaw();
    await retry.start();
    await claw.authority.submit(await kitEnrollment(claw, 1), "mailbox");
    discovery.fail("snapshot", new TypeError("fetch failed"));
    await retry.request();
    retry.stop();
    await advance(PUBLICATION_RETRY_MAX_MS * 2);
    expect(outcomes).toHaveLength(1);
    expect(claw.authority.current()?.discovery.publish_pending).toBe(true);
  });

  it("coalesces requests that arrive during an attempt into one follow-up", async () => {
    let release: (() => void) | undefined;
    const publish = vi.fn(
      () =>
        new Promise<PublishOutcome>((resolve) => {
          release = () => resolve({ state: "published", ownerAccountId: "a", snapshotSeq: 1 });
        }),
    );
    const setPending = vi.fn(async () => {});
    const retry = createPublicationRetry({
      publish,
      current: () => undefined,
      setPending,
      log: log(),
    });
    const first = retry.request();
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    await Promise.all([retry.request(), retry.request()]);
    release!();
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(2));
    release!();
    await first;
    expect(publish).toHaveBeenCalledTimes(2);
    expect(setPending).toHaveBeenLastCalledWith(false);
  });
});

describe("publicationPending", () => {
  it("is false before the claw is registered with Discovery", async () => {
    const claw = await linkedClaw();
    expect(publicationPending(claw.authority.current())).toBe(false);
  });

  it("tracks the durable flag and the published seqs", async () => {
    const claw = await linkedClaw();
    await claw.authority.recordDiscovery({
      owner_account_id: "acct",
      published_binding_seq: 1,
      published_snapshot_seq: 1,
    });
    expect(publicationPending(claw.authority.current())).toBe(false);
    await claw.authority.recordDiscovery({ publish_pending: true });
    expect(publicationPending(claw.authority.current())).toBe(true);
    await claw.authority.recordDiscovery({ publish_pending: false, published_binding_seq: 0 });
    expect(publicationPending(claw.authority.current())).toBe(true);
  });
});
