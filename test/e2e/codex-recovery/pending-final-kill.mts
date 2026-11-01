import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadSessionEntry } from "../../../src/config/sessions/session-accessor.ts";
import { readSessionEntryInWorker } from "../../../src/config/sessions/session-entry-read-runtime.ts";
import { callGateway } from "../../../src/gateway/call.ts";
import { onAgentRuntimeEvent } from "../../../src/infra/agent-events.ts";
import {
  findDeliveryIntentOwner,
  loadPendingDelivery,
} from "../../../src/infra/outbound/delivery-queue-storage.ts";
import { readVisibleSessionTranscriptMessageEntries } from "../../../src/plugin-sdk/session-transcript-runtime.ts";
import { getInProcessGatewayRequestContext } from "../../../src/plugins/runtime/gateway-request-scope.ts";
import { normalizeInputProvenance } from "../../../src/sessions/input-provenance.ts";

export async function waitForPreparedFinalRecovery(params: {
  root: string;
  originalRunId: string;
  hasAutomaticAgentRun: () => boolean;
}): Promise<void> {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  assert.ok(stateDir && path.resolve(stateDir).startsWith(path.resolve(params.root) + path.sep));
  const before = JSON.parse(
    fs.readFileSync(path.join(params.root, "pending-final-before-kill.json"), "utf8"),
  );
  assert.equal(before.seeded, false);
  assert.equal(before.runId, params.originalRunId);
  assert.equal(before.marker.kind, "replayable");
  assert.equal(before.outboundQueueRows, 0);
  const target = {
    agentId: "main",
    sessionKey: before.sessionKey,
    storePath: path.join(stateDir, "agents/main/sessions/sessions.json"),
  };
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    assert.equal(
      params.hasAutomaticAgentRun(),
      false,
      "saved final must not dispatch an automatic agent turn",
    );
    const entry = loadSessionEntry({ ...target, readConsistency: "latest" });
    if (
      entry?.status === "done" &&
      !entry.pendingFinalDelivery &&
      !entry.mainRestartRecovery &&
      !entry.restartRecoveryDeliveryRunId &&
      entry.abortedLastRun !== true
    ) {
      assert.equal(entry.sessionId, before.sessionId);
      const messages = await readVisibleSessionTranscriptMessageEntries({
        ...target,
        sessionId: entry.sessionId,
      });
      const actualInternalContinuation = messages.some(({ message }) => {
        const provenance = normalizeInputProvenance(
          (message as { provenance?: unknown }).provenance,
        );
        return (
          provenance?.kind === "internal_system" &&
          provenance.sourceTool === "main_session_restart_recovery"
        );
      });
      assert.equal(
        actualInternalContinuation,
        false,
        "delivery must not append a new model prompt",
      );
      const deliveries = fs
        .readFileSync(path.join(params.root, "recovery-sink-deliveries.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0].text, before.marker.text);
      assert.equal(deliveries[0].to, before.marker.context.to);
      for (const delivery of before.marker.deliveries) {
        assert.equal(await loadPendingDelivery(delivery.id, stateDir), null);
      }
      const evidence = {
        originalRunId: params.originalRunId,
        terminalPhase: "delivery-settled",
        status: entry.status,
        deliveryCount: deliveries.length,
        actualInternalContinuation,
        runtimeStampedAutomaticContinuation: false,
        recoveryClaimCleared: true,
      };
      fs.writeFileSync(
        path.join(params.root, "pending-final-after-recovery.json"),
        JSON.stringify(evidence, null, 2),
      );
      fs.writeFileSync(
        path.join(params.root, "startup-recovery.json"),
        JSON.stringify(evidence, null, 2),
      );
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
  }
  throw new Error("Prepared final recovery did not reach durable delivery settlement");
}

export async function runPendingFinalKill(params: {
  root: string;
  url: string;
  token: string;
  runId: string;
  sessionKey: string;
  channel: string;
  to: string;
  accountId?: string;
}): Promise<never> {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  assert.ok(
    stateDir && typeof process.send === "function",
    "isolated state and parent-owned IPC are required",
  );
  assert.ok(path.resolve(stateDir).startsWith(path.resolve(params.root) + path.sep));
  let bound = false;
  let reachedResolve!: () => void;
  let reachedReject!: (error: unknown) => void;
  const reached = new Promise<void>((resolve, reject) => {
    reachedResolve = resolve;
    reachedReject = reject;
  });
  // The RPC can fail before its callback; retain its original rejection for the
  // caller without creating a detached unhandled rejection while awaiting it.
  void reached.catch(() => {});
  const stop = onAgentRuntimeEvent((event) => {
    if (
      bound ||
      event.runId !== params.runId ||
      event.stream !== "lifecycle" ||
      event.data.phase !== "start"
    ) {
      return;
    }
    try {
      const context = getInProcessGatewayRequestContext();
      assert.ok(context, "real run event must retain the Gateway context; no synthetic fallback");
      const owner = context.chatAbortControllers.get(params.runId);
      assert.ok(owner, "real RPC must own its abort-controller registration");
      assert.equal(owner.sessionKey, params.sessionKey);
      const producer = owner.resolveTerminalProducer?.();
      assert.ok(producer, "real terminal producer must validate its live authority");
      const assertOwner = () => {
        assert.equal(context.chatAbortControllers.get(params.runId), owner);
        assert.equal(owner.controller.signal.aborted, false);
        assert.notEqual(owner.registrationCleanupRequested, true);
        // The native inference may already be terminal; do not require its tool
        // lease to stay live. The actual producer accepted this settlement while
        // current, and the exact Gateway execution registration must still own it.
      };
      const accepted = producer.handoff(async (producerCompleted) => {
        try {
          await producerCompleted;
          assertOwner();
          const entry = await readSessionEntryInWorker(
            {
              agentId: "main",
              sessionKey: params.sessionKey,
              storePath: path.join(stateDir, "agents/main/sessions/sessions.json"),
            },
            assertOwner,
          );
          assertOwner();
          assert.ok(entry);
          assert.equal(entry.sessionId, producer.sessionId);
          const marker = entry.pendingFinalDelivery;
          assert.ok(marker, "real post-run producer must persist pending final before callback");
          if (marker.kind !== "replayable") {
            throw new Error("expected real replayable final marker");
          }
          assert.ok(marker.text?.includes("RECOVERY_OK"));
          assert.ok(marker.deliveries?.length);
          for (const delivery of marker.deliveries) {
            assert.equal(delivery.state, "prepared");
            assert.equal(await loadPendingDelivery(delivery.id, stateDir), null);
            assertOwner();
            assert.equal(await findDeliveryIntentOwner(delivery.id, stateDir), null);
            assertOwner();
          }
          const evidence = {
            fixtureKind: "real-rpc-producer-terminal-handoff-before-outbound-enqueue",
            seeded: false,
            runId: params.runId,
            sessionKey: params.sessionKey,
            sessionId: entry.sessionId,
            // Record actual lifecycle; never rewind it to running for the fixture.
            status: entry.status,
            recoveryRunId: entry.restartRecoveryDeliveryRunId,
            marker,
            outboundQueueRows: 0,
            liveRegisteredProducer: true,
            nativeCompletionMustBeVerifiedByParentWire: true,
            gatewayPid: process.pid,
          };
          fs.writeFileSync(
            path.join(params.root, "pending-final-before-kill.json"),
            JSON.stringify(evidence, null, 2),
          );
          fs.writeFileSync(
            path.join(params.root, "interrupted-request.json"),
            JSON.stringify({
              label: "original",
              runId: params.runId,
              error: "parent kill after real prepared marker before outbound queue custody",
            }),
          );
          await new Promise<void>((resolve, reject) => {
            process.send?.(
              {
                kind: "pending-final-before-enqueue",
                runId: params.runId,
                sessionId: entry.sessionId,
              },
              (error) => (error ? reject(error) : resolve()),
            );
          });
          reachedResolve();
          await new Promise<never>(() => {});
        } catch (error) {
          reachedReject(error);
          throw error; // terminalProducer.complete rejects; normal delivery cannot continue.
        }
      });
      assert.equal(accepted, true, "only the existing owner can accept terminal settlement");
      bound = true;
    } catch (error) {
      reachedReject(error);
    }
  });
  try {
    const result = callGateway({
      url: params.url,
      token: params.token,
      method: "agent",
      params: {
        message: "Reply with RECOVERY_OK. This is an isolated prepared-final crash probe.",
        sessionKey: params.sessionKey,
        idempotencyKey: params.runId,
        deliver: true,
        channel: params.channel,
        replyChannel: params.channel,
        replyTo: params.to,
        ...(params.accountId ? { replyAccountId: params.accountId } : {}),
      },
      expectFinal: true,
      timeoutMs: 120000,
    });
    await Promise.race([
      reached,
      result.then((value) => {
        throw new Error(`RPC settled before the pending-final barrier: ${JSON.stringify(value)}`);
      }),
    ]);
    // Parent checks wire turn/completed, kills only this child, then starts the
    // ordinary Gateway entry on unchanged state/config. Parent records actual
    // startup dispatch/no-dispatch, marker/queue state and final send count.
    await result;
    throw new Error("parent did not kill the held terminal producer");
  } finally {
    stop();
  }
}
