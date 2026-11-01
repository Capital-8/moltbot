import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { loadSessionEntry } from "../../../src/config/sessions/session-accessor.ts";
import { callGateway } from "../../../src/gateway/call.ts";
import { getGatewayRecoveryRuntime } from "../../../src/gateway/server-recovery-runtime-context.ts";
import { onAgentRuntimeEvent } from "../../../src/infra/agent-events.ts";
import {
  getAgentRunContext,
  hasAgentRunContextExecutionOwner,
} from "../../../src/infra/agent-run-registry.ts";

/** Install before replacement Gateway startup; the proxy owns the wire barrier. */
export function installRecoveryOverlapProbe(params: {
  root: string;
  port: number;
  action: "same-session-message" | "second-deployment-preflight";
}) {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  assert.ok(stateDir, "probe requires the fixture's isolated state directory");
  const target = {
    agentId: "main",
    sessionKey: "agent:main:main",
    storePath: path.join(stateDir, "agents/main/sessions/sessions.json"),
  };
  const evidencePath = path.join(params.root, "recovery-overlap.json");
  const original = JSON.parse(
    fs.readFileSync(path.join(params.root, "interrupted-request.json"), "utf8"),
  );
  const events: unknown[] = [];
  let automaticRunId: string | undefined;
  let handled = false;
  let resolveDone!: (evidence: unknown) => void;
  let rejectDone!: (error: unknown) => void;
  const done = new Promise<unknown>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const readEntry = () => loadSessionEntry({ ...target, readConsistency: "latest" });
  const save = (evidence: Record<string, unknown>) => {
    fs.writeFileSync(
      evidencePath,
      JSON.stringify(
        {
          action: params.action,
          originalRunId: original.runId,
          automaticRunId,
          events,
          ...evidence,
        },
        null,
        2,
      ),
    );
  };
  const offEvents = onAgentRuntimeEvent((event) => {
    if (event.sessionKey !== target.sessionKey || event.stream !== "lifecycle") {
      return;
    }
    events.push({
      runId: event.runId,
      phase: event.data.phase,
      data: event.data,
      automatic: event.mainSessionRestartRecovery === true,
    });
  });
  const run = async () => {
    const entryAtBarrier = readEntry();
    automaticRunId = entryAtBarrier?.restartRecoveryDeliveryRunId;
    assert.ok(automaticRunId, "held original-thread read must have an admitted recovery owner");
    assert.notEqual(automaticRunId, original.runId);
    assert.equal(entryAtBarrier?.lifecycleRunId, automaticRunId);
    assert.equal(entryAtBarrier?.abortedLastRun, false);
    assert.equal(entryAtBarrier?.status, "running");
    const context = getAgentRunContext(automaticRunId);
    const ownsExecution = hasAgentRunContextExecutionOwner(automaticRunId);
    assert.equal(context?.sessionKey, target.sessionKey);
    assert.equal(context?.sessionId, entryAtBarrier?.sessionId);
    assert.equal(context?.mainSessionRestartRecovery, true);
    assert.equal(ownsExecution, true, "projection metadata alone is not a live recovery owner");
    const ownerAtBarrier = {
      runId: automaticRunId,
      sessionId: context?.sessionId,
      lifecycleGeneration: context?.lifecycleGeneration,
      lifecycleStartedAt: context?.lifecycleStartedAt,
      ownsExecution,
    };
    const effectAtBarrier = fs.readFileSync(
      path.join(params.root, "workspace/effect-count.txt"),
      "utf8",
    );
    assert.equal(effectAtBarrier, "effect\n");
    save({
      boundary: "recovery-admitted-preflight-native-read-response-held",
      entryAtBarrier,
      ownerAtBarrier,
      effectAtBarrier,
    });
    if (params.action === "second-deployment-preflight") {
      // Parent kills only this fixture-owned Gateway. Do not release the read or
      // invent a recovery result: next process must rediscover the durable owner.
      process.send?.({ kind: "recovery-overlap-second-deployment-ready", runId: automaticRunId });
      return {
        interruptedAt: "recovery-admitted-preflight-native-read-response-held",
        automaticRunId,
      };
    }
    const newRunId = randomUUID();
    const marker = `RECOVERY_OVERLAP_FRESH_${newRunId}`;
    const wireOffset = fs.statSync(path.join(params.root, "wire.jsonl")).size;
    const logOffset = fs.statSync(path.join(params.root, "openclaw.log")).size;
    const accepted = await callGateway({
      url: `ws://127.0.0.1:${params.port}`,
      token: "synthetic-gateway-token",
      method: "agent",
      params: {
        message: `New user request after deployment: reply with FOLLOWUP_OK. ${marker}`,
        sessionKey: target.sessionKey,
        idempotencyKey: newRunId,
        deliver: false,
      },
      expectFinal: false,
      timeoutMs: 120000,
    });
    const entryAtAcceptance = readEntry();
    save({
      boundary: "fresh-request-accepted-native-read-still-held",
      newRunId,
      marker,
      accepted,
      entryAtBarrier,
      ownerAtBarrier,
      entryAtAcceptance,
      effectAtBarrier,
    });
    assert.equal(asOptionalRecord(accepted)?.runId, newRunId);
    assert.ok(["accepted", "in_flight"].includes(String(asOptionalRecord(accepted)?.status)));
    process.send?.({ kind: "recovery-overlap-release-read", newRunId, automaticRunId });
    const runtime = getGatewayRecoveryRuntime();
    assert.ok(runtime);
    const [oldTerminal, newTerminal] = await Promise.all([
      runtime.waitForAgent({ runId: automaticRunId, timeoutMs: 120000 }, 125000),
      runtime.waitForAgent({ runId: newRunId, timeoutMs: 120000 }, 125000),
    ]);
    const after = readEntry();
    const effectAfter = fs.readFileSync(
      path.join(params.root, "workspace/effect-count.txt"),
      "utf8",
    );
    const wire = fs
      .readFileSync(path.join(params.root, "wire.jsonl"))
      .subarray(wireOffset)
      .toString("utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const nativeStarts = wire.filter(
      (event) => event.event === "to-native" && event.data?.method === "turn/start",
    );
    const evidence = {
      boundary: "both-real-runs-settled",
      newRunId,
      marker,
      accepted,
      entryAtBarrier,
      ownerAtBarrier,
      entryAtAcceptance,
      oldTerminal,
      newTerminal,
      after,
      effectAtBarrier,
      effectAfter,
      nativeStarts: nativeStarts.map((event) => ({
        threadId: event.data.params?.threadId,
        containsFreshMarker: JSON.stringify(event.data.params).includes(marker),
      })),
    };
    save(evidence);
    assert.match(
      fs.readFileSync(path.join(params.root, "openclaw.log")).subarray(logOffset).toString("utf8"),
      /Codex automatic recovery stopped because the previous host task outcome is uncertain/,
      "a different preflight error must not stand in for the real cold recovery guard",
    );
    assert.equal(
      asOptionalRecord(oldTerminal)?.status,
      "error",
      "real cold guard remains authoritative",
    );
    assert.equal(
      asOptionalRecord(newTerminal)?.status,
      "ok",
      "fresh message must get its own terminal outcome",
    );
    assert.equal(after?.status, "done");
    assert.equal(after?.abortedLastRun, false);
    assert.equal(after?.restartRecoveryDeliveryRunId, undefined);
    assert.equal(after?.mainRestartRecovery, undefined);
    assert.equal(
      effectAfter,
      "effect\n",
      "recovery and fresh message must not repeat original effect",
    );
    assert.equal(
      nativeStarts.length,
      1,
      "only the genuinely fresh request may start native inference",
    );
    assert.equal(evidence.nativeStarts[0]?.containsFreshMarker, true);
    return evidence;
  };
  const onMessage = (message: unknown) => {
    if (handled || asOptionalRecord(message)?.kind !== "recovery-overlap-read-held") {
      return;
    }
    handled = true;
    void run().then(resolveDone, (error: unknown) => {
      fs.writeFileSync(path.join(params.root, "recovery-overlap-error.txt"), String(error));
      process.send?.({ kind: "recovery-overlap-release-read", failed: true });
      rejectDone(error);
    });
  };
  process.on("message", onMessage);
  return {
    done,
    dispose: () => {
      offEvents();
      process.off("message", onMessage);
    },
  };
}
