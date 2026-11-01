import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { markOrphanedMainSessionForRecovery } from "../../../src/agents/main-session-recovery/main-session-restart-recovery-marking.ts";
import { recoverRestartAbortedMainSessions } from "../../../src/agents/main-session-recovery/main-session-restart-recovery-runtime.ts";
import { persistPendingFinalDeliveryMarker } from "../../../src/agents/pending-final-delivery-marker.ts";
import { loadConfig } from "../../../src/config/config.ts";
import {
  applySessionEntryReplacements,
  loadSessionEntry,
} from "../../../src/config/sessions/session-accessor.ts";
import type { GatewayRecoveryRuntime } from "../../../src/gateway/server-instance-runtime.types.ts";
import { getGatewayRecoveryRuntime } from "../../../src/gateway/server-recovery-runtime-context.ts";

/** Characterizes a seeded pre-queue state; this does not inject a real process crash. */
export async function reproducePendingFinalComposition(params: {
  root: string;
  originalRunId: string;
  originalResult: unknown;
}): Promise<void> {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  assert.ok(stateDir, "fixture needs isolated state");
  const target = {
    agentId: "main",
    sessionKey: "agent:main:main",
    storePath: path.join(stateDir, "agents/main/sessions/sessions.json"),
  };
  const result = asOptionalRecord(params.originalResult);
  assert.equal(result?.status, "ok", "original real native task must complete first");
  const payloads = asOptionalRecord(result?.result)?.payloads;
  assert.ok(Array.isArray(payloads) && payloads.length === 1);
  const text = asOptionalRecord(payloads[0])?.text;
  assert.ok(typeof text === "string");
  assert.ok(text.length > 0);
  const before = loadSessionEntry({ ...target, readConsistency: "latest" });
  assert.ok(before);
  assert.equal(before.status, "done");
  assert.equal(before.pendingFinalDelivery, undefined);
  const marker = await persistPendingFinalDeliveryMarker({
    ...target,
    deliver: true,
    sessionStore: { [target.sessionKey]: before },
    sessionEntry: before,
    suppressVisibleSessionEffects: false,
    sessionReboundDuringRun: false,
    payloads: [{ text }],
    deliveryContext: { channel: "discord", to: "channel:synthetic-r8-unsent" },
    runOwnedSessionId: before.sessionId,
  });
  assert.equal(marker.pendingFinalDeliveryMarkerPersisted, true);
  const prepared = loadSessionEntry({ ...target, readConsistency: "latest" });
  assert.equal(prepared?.pendingFinalDelivery?.kind, "replayable");
  assert.deepEqual(
    prepared?.pendingFinalDelivery?.deliveries?.map((d) => d.state),
    ["prepared"],
  );

  // Explicit seed: only the outer host lifecycle is rewound. The original native
  // thread/transcript and real producer marker remain intact. No queue admission.
  await applySessionEntryReplacements({
    ...target,
    sessionKeys: [target.sessionKey],
    update: (entries) => {
      const entry = entries.find((e) => e.sessionKey === target.sessionKey)?.entry;
      assert.equal(entry?.sessionId, before.sessionId);
      assert.ok(entry);
      return {
        result: undefined,
        replacements: [
          {
            sessionKey: target.sessionKey,
            entry: {
              ...entry,
              status: "running",
              endedAt: undefined,
              abortedLastRun: false,
              lifecycleRunId: params.originalRunId,
              activeWriterRunId: undefined,
            },
          },
        ],
      };
    },
  });
  const cfg = loadConfig();
  // Suppress all external delivery in this isolated admission reproduction.
  // The agent invocation still runs with deliver:false via the real resolver.
  const recoveryCfg = {
    ...cfg,
    session: { ...cfg.session, sendPolicy: { default: "deny" as const } },
  };
  const marked = await markOrphanedMainSessionForRecovery({
    target,
    expectedSessionId: before.sessionId,
    cfg: recoveryCfg,
  });
  assert.equal(marked.marked, 1, "real orphan owner must claim the seeded host state");
  const runtime = getGatewayRecoveryRuntime();
  assert.ok(runtime, "use the running Gateway's real recovery principal");
  const dispatched: unknown[] = [];
  const observedRuntime: GatewayRecoveryRuntime = {
    ...runtime,
    dispatchAgent: async <T,>(...args: Parameters<GatewayRecoveryRuntime["dispatchAgent"]>) => {
      dispatched.push(args[0]);
      return await runtime.dispatchAgent<T>(...args);
    },
  };
  const wireOffset = fs.statSync(path.join(params.root, "wire.jsonl")).size;
  const logOffset = fs.statSync(path.join(params.root, "openclaw.log")).size;
  const counts = await recoverRestartAbortedMainSessions({
    cfg: recoveryCfg,
    stateDir,
    gatewayRuntime: observedRuntime,
  });
  const deadline = Date.now() + 120000;
  let after = loadSessionEntry({ ...target, readConsistency: "latest" });
  while (after?.status === "running" && Date.now() < deadline) {
    await delay(25);
    after = loadSessionEntry({ ...target, readConsistency: "latest" });
  }
  const dispatch = asOptionalRecord(dispatched[0]);
  const logTail = fs
    .readFileSync(path.join(params.root, "openclaw.log"))
    .subarray(logOffset)
    .toString("utf8");
  const wireTail = fs
    .readFileSync(path.join(params.root, "wire.jsonl"))
    .subarray(wireOffset)
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  fs.writeFileSync(
    path.join(params.root, "pending-final-composition.json"),
    JSON.stringify(
      {
        fixtureKind: "seeded-host-state-real-producer-real-gateway-real-codex-guard",
        originalRunId: params.originalRunId,
        sessionId: before.sessionId,
        marker: prepared?.pendingFinalDelivery,
        counts,
        dispatched,
        after,
        nativeTurnStarts: wireTail.filter(
          (e) => e.event === "to-native" && e.data?.method === "turn/start",
        ).length,
        realKillWindow: false,
        externalDeliveryTested: false,
      },
      null,
      2,
    ),
  );
  assert.equal(dispatched.length, 1);
  assert.equal(dispatch?.deliver, false);
  assert.equal(
    asOptionalRecord(dispatch?.inputProvenance)?.sourceTool,
    "main_session_restart_recovery",
  );
  assert.ok(typeof dispatch?.message === "string" && dispatch.message.includes(text));
  assert.match(
    logTail,
    /Codex automatic recovery stopped because the previous host task outcome is uncertain/,
  );
  assert.equal(after?.status, "failed");
  assert.equal(
    wireTail.filter((e) => e.event === "to-native" && e.data?.method === "turn/start").length,
    0,
  );
}
