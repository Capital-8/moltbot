import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { loadSessionEntry } from "../../../src/config/sessions/session-accessor.ts";
import { callGateway } from "../../../src/gateway/call.ts";
import type { startGatewayServer } from "../../../src/gateway/server.ts";
import { onAgentRuntimeEvent } from "../../../src/infra/agent-events.ts";
import { readVisibleSessionTranscriptMessageEntries } from "../../../src/plugin-sdk/session-transcript-runtime.ts";
import { getGatewayRestartDrainSignal } from "../../../src/process/gateway-work-admission.ts";
import { normalizeInputProvenance } from "../../../src/sessions/input-provenance.ts";
import { startFixtureGateway } from "./start-fixture-gateway.mts";
const root = process.env.OC_REPRO_ROOT;
if (!root) {
  throw new Error("Missing isolated output directory");
}
const gatewayLogOffset = fs.statSync(root + "/openclaw.log").size;
const recoveryEvents: Array<{
  runId: string;
  sessionKey?: string;
  phase: unknown;
  automatic: boolean;
}> = [];
const off = onAgentRuntimeEvent((e) => {
  if (e.stream === "lifecycle") {
    recoveryEvents.push({
      runId: e.runId,
      sessionKey: e.sessionKey,
      phase: e.data.phase,
      automatic: e.mainSessionRestartRecovery === true,
    });
  }
  if (["lifecycle", "tool", "error"].includes(e.stream)) {
    const evidence =
      process.env.OC_REPRO_LIVE_SLACK === "1"
        ? {
            runId: e.runId,
            sessionKey: e.sessionKey,
            stream: e.stream,
            seq: e.seq,
            ts: e.ts,
            mainSessionRestartRecovery: e.mainSessionRestartRecovery === true,
            data: {
              phase: e.data.phase,
              name: e.data.name,
              toolCallId: e.data.toolCallId,
              isError: e.data.isError,
            },
          }
        : { ...e, mainSessionRestartRecovery: e.mainSessionRestartRecovery === true };
    fs.appendFileSync(root + "/agent-events.jsonl", JSON.stringify(evidence) + "\n");
  }
});
async function waitForAutomaticRecovery(originalRunId: string): Promise<void> {
  if (
    process.env.OC_REPRO_MODE?.includes("pending-final-kill") &&
    process.env.OC_REPRO_EXPECT_RECOVERED === "1"
  ) {
    const { waitForPreparedFinalRecovery } = await import("./pending-final-kill.mts");
    await waitForPreparedFinalRecovery({
      root: root!,
      originalRunId,
      hasAutomaticAgentRun: () => recoveryEvents.some((event) => event.automatic),
    });
    return;
  }
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("Missing isolated state directory");
  }
  const target = {
    agentId: "main",
    sessionKey: "agent:main:main",
    storePath: path.join(stateDir, "agents/main/sessions/sessions.json"),
  };
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const terminal = recoveryEvents.find(
      (event) =>
        event.automatic &&
        event.sessionKey === target.sessionKey &&
        (event.phase === "error" || event.phase === "end"),
    );
    const entry = loadSessionEntry({ ...target, readConsistency: "latest" });
    if (
      terminal &&
      entry &&
      (entry.status === "failed" || entry.status === "done") &&
      entry.mainRestartRecovery === undefined &&
      entry.restartRecoveryDeliveryRunId === undefined &&
      entry.abortedLastRun !== true &&
      entry.restartRecoveryTerminalRunIds?.includes(terminal.runId)
    ) {
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
      const pendingFinalKill = process.env.OC_REPRO_MODE?.includes("pending-final-kill") === true;
      const liveHandoff = process.env.OC_REPRO_MODE?.includes("live-handoff") === true;
      const firstDispatch =
        process.env.OC_REPRO_MODE?.includes("adopt-before-start") &&
        process.env.OC_REPRO_EXPECT_RECOVERED === "1";
      if (!actualInternalContinuation && !pendingFinalKill && !liveHandoff && !firstDispatch) {
        throw new Error("No actual startup continuation in durable transcript");
      }
      if (pendingFinalKill) {
        const beforeKill = JSON.parse(
          fs.readFileSync(root + "/pending-final-before-kill.json", "utf8"),
        );
        if (
          beforeKill.seeded !== false ||
          beforeKill.runId !== originalRunId ||
          beforeKill.marker?.kind !== "replayable" ||
          beforeKill.outboundQueueRows !== 0 ||
          !fs
            .readFileSync(root + "/openclaw.log")
            .subarray(gatewayLogOffset)
            .toString("utf8")
            .includes("started interrupted main session: agent:main:main (with pending payload)")
        ) {
          throw new Error("Missing actual prepared-final startup recovery evidence");
        }
        fs.writeFileSync(
          root + "/pending-final-after-recovery.json",
          JSON.stringify(
            {
              status: entry.status,
              marker: entry.pendingFinalDelivery,
              recoveryRunId: terminal.runId,
              automatic: terminal.automatic,
              hasAdditionalInternalTranscriptInput: actualInternalContinuation,
            },
            null,
            2,
          ),
        );
      }
      let adoptedSourceUserCount: number | undefined;
      if (/adopt-before-start|channel-run/.test(process.env.OC_REPRO_MODE ?? "")) {
        const { sourceTurnId } = JSON.parse(
          fs.readFileSync(root + "/ingress-adopted-before-native.json", "utf8"),
        );
        adoptedSourceUserCount = messages.filter(
          ({ message }) =>
            asOptionalRecord(message)?.role === "user" &&
            asOptionalRecord(message)?.idempotencyKey === sourceTurnId,
        ).length;
        if (adoptedSourceUserCount !== 1) {
          throw new Error("The adopted source must remain unique after recovery");
        }
      }
      let liveHandoffDeliveryCount: number | undefined;
      if ((liveHandoff || firstDispatch) && process.env.OC_REPRO_EXPECT_RECOVERED === "1") {
        if (terminal.phase !== "end" || entry.status !== "done") {
          throw new Error(
            `Original task recovery failed before delivery: run=${terminal.runId} phase=${String(terminal.phase)} status=${entry.status}`,
          );
        }
        const deliveries = fs
          .readFileSync(path.join(root!, "recovery-sink-deliveries.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        if (
          deliveries.length !== 1 ||
          deliveries[0].to !==
            (firstDispatch || process.env.OC_REPRO_MODE?.includes("channel-run")
              ? "user:U_INGRESS_REPRO"
              : "synthetic-r8-recipient") ||
          !String(deliveries[0].text).includes("RECOVERY_OK")
        ) {
          throw new Error(
            "Recovered original result must reach its original local sink exactly once",
          );
        }
        liveHandoffDeliveryCount = deliveries.length;
      }
      fs.writeFileSync(
        root + "/startup-recovery.json",
        JSON.stringify(
          {
            originalRunId,
            recoveryRunId: terminal.runId,
            terminalPhase: terminal.phase,
            status: entry.status,
            terminalRunIds: entry.restartRecoveryTerminalRunIds,
            actualInternalContinuation,
            runtimeStampedAutomaticContinuation: terminal.automatic,
            recoveryClaimCleared: true,
            adoptedSourceUserCount,
            liveHandoffDeliveryCount,
          },
          null,
          2,
        ),
      );
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
  }
  throw new Error("Automatic startup recovery did not reach durable terminal cleanup");
}
// This runs inside the real Gateway so the active storage backend is initialized.
// Export correlation/state only; raw transcript content and credentials stay private.
async function inspectLiveSession(sessionKey: string, probeId: string): Promise<void> {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  const prefix = process.env.OC_REPRO_SLACK_SESSION_PREFIX;
  if (
    process.env.OC_REPRO_LIVE_SLACK !== "1" ||
    !stateDir ||
    !prefix ||
    !sessionKey.startsWith("agent:main:") ||
    !(
      sessionKey.toLowerCase() === prefix ||
      sessionKey.toLowerCase().startsWith(prefix + ":thread:")
    ) ||
    !/^[a-z0-9-]{1,80}$/.test(probeId)
  ) {
    throw new Error("Invalid isolated live session probe");
  }
  const target = {
    agentId: "main",
    sessionKey,
    storePath: path.join(stateDir, "agents/main/sessions/sessions.json"),
  };
  const entry = loadSessionEntry({ ...target, readConsistency: "latest" });
  if (!entry) {
    throw new Error("Live Slack session has not been admitted");
  }
  const messages = await readVisibleSessionTranscriptMessageEntries({
    ...target,
    sessionId: entry.sessionId,
  });
  const userTurns = messages.flatMap(({ message }) => {
    const record = asOptionalRecord(message);
    if (record?.role !== "user") {
      return [];
    }
    const transport = asOptionalRecord(
      asOptionalRecord(Reflect.get(record, "__openclaw"))?.transport,
    );
    const provenance = normalizeInputProvenance(record.provenance);
    return [
      {
        idempotencyKey: record.idempotencyKey,
        provenanceKind: provenance?.kind,
        provenanceSourceTool: provenance?.sourceTool,
        transport: transport
          ? {
              channel: transport.channel,
              conversationRef: transport.conversationRef,
              messageId: transport.messageId,
              threadId: transport.threadId,
            }
          : undefined,
      },
    ];
  });
  const receipt = {
    probeId,
    capturedAt: Date.now(),
    sessionKey,
    sessionId: entry.sessionId,
    status: entry.status,
    lastRunId: entry.lastRunId,
    lifecycleRunId: entry.lifecycleRunId,
    abortedLastRun: entry.abortedLastRun === true,
    recoveryClaimPresent: entry.mainRestartRecovery !== undefined,
    recoveryDeliveryRunId: entry.restartRecoveryDeliveryRunId,
    recoverySourceRunId: entry.restartRecoveryDeliverySourceRunId,
    pendingFinalDelivery: entry.pendingFinalDelivery !== undefined,
    terminalRunIds: entry.restartRecoveryTerminalRunIds ?? [],
    userTurns,
    lifecycle: recoveryEvents.filter((event) => event.sessionKey === sessionKey),
    deliveredCheckpointReconciled: fs
      .readFileSync(root + "/openclaw.log")
      .subarray(gatewayLogOffset)
      .toString("utf8")
      .includes(`reconciled delivered terminal reply after restart: ${sessionKey}`),
  };
  fs.writeFileSync(root + `/live-session-${probeId}.json`, JSON.stringify(receipt, null, 2));
}
let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
let processLoop: Promise<void> | undefined;
let sibling: ReturnType<typeof callGateway> | undefined;
let overlapProbe:
  | ReturnType<typeof import("./recovery-overlap.mts").installRecoveryOverlapProbe>
  | undefined;
let ready: () => void = () => {};
let stopLive: () => void = () => {};
const liveStopped = new Promise<void>((resolve) => {
  stopLive = resolve;
});
let backendRestored: () => void = () => {};
const backendReady = new Promise<void>((resolve) => {
  backendRestored = resolve;
});
let closeIdleGateway: () => void = () => {};
const idleGatewayClose = new Promise<void>((resolve) => {
  closeIdleGateway = resolve;
});
const siblingReady = new Promise<void>((resolve) => {
  ready = resolve;
});
process.on("message", (message) => {
  if (
    process.env.OC_REPRO_MODE?.includes("planned-receipt-cut") &&
    message &&
    typeof message === "object" &&
    "kind" in message &&
    message.kind === "prepare-planned-receipt-cut"
  ) {
    void callGateway<{ status: string }>({
      url: `ws://127.0.0.1:${Number(process.env.OC_REPRO_GATEWAY_PORT)}`,
      token: "synthetic-gateway-token",
      method: "gateway.suspend.prepare",
      params: {
        requestId: "original-rollout",
        drain: true,
        plannedDeadlineMs: Date.now() + 30 * 60_000,
      },
    }).then((result) => {
      assert.equal(result.status, "draining");
      process.send?.({ kind: "planned-receipt-cut-armed" });
    });
  }
  if (
    message &&
    typeof message === "object" &&
    "kind" in message &&
    message.kind === "idle-restart-close"
  ) {
    closeIdleGateway();
  }
  if (
    message &&
    typeof message === "object" &&
    "kind" in message &&
    message.kind === "inspect-live-session" &&
    "sessionKey" in message &&
    typeof message.sessionKey === "string" &&
    "probeId" in message &&
    typeof message.probeId === "string"
  ) {
    const probeId = message.probeId;
    void inspectLiveSession(message.sessionKey, probeId).catch((error: unknown) => {
      console.error("Live session evidence failed", error);
      process.send?.({ kind: "live-probe-failed", probeId });
    });
  }
  if (message && typeof message === "object" && "kind" in message && message.kind === "stop-live") {
    stopLive();
  }
  if (
    message &&
    typeof message === "object" &&
    "kind" in message &&
    message.kind === "backend-restored"
  ) {
    backendRestored();
  }
  if (
    message &&
    typeof message === "object" &&
    "kind" in message &&
    message.kind === "sibling-ready"
  ) {
    ready();
  }
});
try {
  const port = Number(process.env.OC_REPRO_GATEWAY_PORT);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("Missing parent-owned Gateway port");
  }
  if (
    process.env.OC_REPRO_GATEWAY_GENERATION === "1" &&
    (process.env.OC_REPRO_MODE?.endsWith("-overlap") ||
      process.env.OC_REPRO_MODE?.includes("second-deployment-started"))
  ) {
    const { installRecoveryOverlapProbe } = await import("./recovery-overlap.mts");
    overlapProbe = installRecoveryOverlapProbe({
      root,
      port,
      action: process.env.OC_REPRO_MODE.includes("second-deployment-started")
        ? "second-deployment-preflight"
        : "same-session-message",
    });
  }
  ({ server, processLoop } = await startFixtureGateway(port));
  if (process.env.OC_REPRO_LIVE_SLACK === "1") {
    fs.writeFileSync(
      root + "/gateway-ready.json",
      JSON.stringify({
        port,
        pid: process.pid,
        restarted: process.env.OC_REPRO_GATEWAY_PHASE === "recovered",
      }),
    );
    await liveStopped;
  } else {
    if (process.env.OC_REPRO_MODE?.includes("sibling")) {
      sibling = callGateway({
        url: `ws://127.0.0.1:${port}`,
        token: "synthetic-gateway-token",
        method: "agent",
        params: {
          message: "SIBLING_HOLD",
          sessionKey: "agent:main:sibling",
          idempotencyKey: randomUUID(),
          deliver: false,
        },
        expectFinal: true,
        timeoutMs: 120000,
      }).catch((e: unknown) => ({ error: String(e) }));
      await siblingReady;
    }
    const recoveringGateway = process.env.OC_REPRO_GATEWAY_PHASE === "recovered";
    if (!recoveringGateway && process.env.OC_REPRO_MODE?.includes("pending-final-kill")) {
      const { runPendingFinalKill } = await import("./pending-final-kill.mts");
      await runPendingFinalKill({
        root,
        url: `ws://127.0.0.1:${port}`,
        token: "synthetic-gateway-token",
        runId: randomUUID(),
        sessionKey: "agent:main:main",
        channel: "recovery-sink",
        to: "synthetic-r8-recipient",
        accountId: "default",
      });
    }
    const results: Array<Record<string, unknown>> = recoveringGateway
      ? [JSON.parse(fs.readFileSync(root + "/interrupted-request.json", "utf8"))]
      : [];
    if (recoveringGateway && process.env.OC_REPRO_MODE?.includes("automatic-startup")) {
      if (overlapProbe) {
        await overlapProbe.done;
        if (process.env.OC_REPRO_MODE.includes("second-deployment-started")) {
          await new Promise<never>(() => {});
        }
        overlapProbe.dispose();
      } else {
        await waitForAutomaticRecovery(String(results[0]?.runId));
        if (
          process.env.OC_REPRO_MODE?.includes("live-handoff") &&
          process.env.OC_REPRO_EXPECT_RECOVERED === "1"
        ) {
          await new Promise<void>((resolve, reject) => {
            const onMessage = (message: unknown) => {
              if (asOptionalRecord(message)?.kind === "live-handoff-settlement-verified") {
                clearTimeout(timer);
                process.off("message", onMessage);
                resolve();
              }
            };
            const timer = setTimeout(() => {
              process.off("message", onMessage);
              reject(new Error("Original binding settlement verification timed out"));
            }, 30000);
            process.on("message", onMessage);
            process.send?.({ kind: "live-handoff-settled-before-followups" }, (error) => {
              if (error) {
                clearTimeout(timer);
                process.off("message", onMessage);
                reject(error);
              }
            });
          });
        }
      }
    }
    for (const [label, sessionKey] of [
      ["original", "agent:main:main"],
      ["subsequent", "agent:main:main"],
      ["independent", "agent:main:independent"],
    ] as const) {
      if (recoveringGateway && label === "original") {
        continue;
      }
      const repairId = randomUUID();
      const cronAuthorityProbe =
        label === "original" && process.env.OC_REPRO_MODE?.includes("owner-catalog");
      const runId = cronAuthorityProbe ? `cron-failure-repair:${repairId}` : repairId;
      if (label === "original") {
        fs.writeFileSync(
          root + "/interrupted-request.json",
          JSON.stringify({
            label,
            runId,
            error: "Gateway process interrupted before terminal delivery",
          }),
        );
      }
      try {
        if (cronAuthorityProbe) {
          const { runGatewayCronFailureRepair } =
            await import("../../../src/gateway/server-cron-notifications.ts");
          await runGatewayCronFailureRepair(
            {
              agentId: "main",
              sessionKey,
              jobId: "isolated-recovery-catalog-probe",
              repairId,
              message: "Reply with RECOVERY_OK. This is an isolated recovery probe.",
            },
            undefined,
          );
          // The parent observes a real tool result, cuts its delivery, and kills
          // this owned process. Do not manufacture a receipt or owner identity.
          await new Promise<never>(() => {});
        }
        if (label === "subsequent") {
          process.send?.({ kind: "restore-backend" });
          await backendReady;
        }
        if (label === "subsequent" && process.env.OC_REPRO_MODE?.includes("channel-run")) {
          const { sendChannelFixtureText } = await import("./ingress-channel-fixture.mts");
          let channelRunId: string | undefined;
          const reply = await sendChannelFixtureText(
            {
              port,
              channel: "recovery-sink",
              sessionKey,
              text: `Reply with RECOVERY_OK. RECOVERY_FOLLOWUP_${label}_${runId}`,
              messageId: "1793124728.000002",
            },
            {
              disableBlockStreaming: true,
              onAgentRunStart: (admittedId) => {
                channelRunId = admittedId;
              },
              turnAdoptionLifecycle: { admission: "exclusive", onAdopted: async () => {} },
            },
          );
          const payloads = Array.isArray(reply) ? reply : [reply];
          assert.ok(
            payloads.some((payload) => payload?.text?.trim() === "RECOVERY_OK" && !payload.isError),
            "same channel follow-up needs its own model reply",
          );
          assert.ok(channelRunId, "channel must publish the admitted run ID");
          results.push({
            label,
            runId: channelRunId,
            promptId: runId,
            result: { status: "ok", payloads },
          });
          continue;
        }
        const result = await callGateway({
          url: `ws://127.0.0.1:${port}`,
          token: "synthetic-gateway-token",
          ...(process.env.OC_REPRO_MODE?.includes("owner-catalog") ||
          process.env.OC_REPRO_MODE?.includes("plugin-churn")
            ? { scopes: ["operator.admin" as const] }
            : {}),
          method: "agent",
          params: {
            message:
              label === "original"
                ? "Reply with RECOVERY_OK. This is an isolated overload recovery probe."
                : `New independent request: reply with FOLLOWUP_OK. RECOVERY_FOLLOWUP_${label}_${runId}`,
            sessionKey,
            idempotencyKey: runId,
            ...(label === "original" && process.env.OC_REPRO_MODE?.includes("live-handoff")
              ? {
                  deliver: true,
                  channel: "recovery-sink",
                  replyChannel: "recovery-sink",
                  replyTo: "synthetic-r8-recipient",
                  replyAccountId: "default",
                }
              : { deliver: false }),
          },
          expectFinal: true,
          timeoutMs: 120000,
        });
        if (
          label === "original" &&
          process.env.OC_REPRO_MODE === "gateway-remote-pending-final-composition"
        ) {
          const { reproducePendingFinalComposition } =
            await import("./pending-final-composition.mts");
          await reproducePendingFinalComposition({
            root,
            originalRunId: runId,
            originalResult: result,
          });
        }
        results.push({ label, runId, result });
        console.log("REPRO_GATEWAY_RESULT " + JSON.stringify({ label, result }));
        if (label === "original" && process.env.OC_REPRO_MODE?.includes("idle-restart")) {
          fs.writeFileSync(
            root + "/interrupted-request.json",
            JSON.stringify({ label, runId, result }),
          );
          process.send?.({ kind: "idle-restart-ready" });
          await idleGatewayClose;
          break;
        }
      } catch (error) {
        results.push({ label, runId, error: String(error) });
        console.log("REPRO_GATEWAY_RESULT " + JSON.stringify({ label, error: String(error) }));
        if (label === "original" && processLoop && getGatewayRestartDrainSignal().aborted) {
          await processLoop; // The signal owner closes the original Gateway.
        }
        if (label === "original" && process.env.OC_REPRO_MODE?.includes("live-handoff")) {
          fs.writeFileSync(
            root + "/original-request-failure.json",
            JSON.stringify({ runId, error: String(error) }, null, 2),
          );
          throw new Error(
            "Original handoff fixture request failed before the controlled deployment; no fresh request may substitute for it",
            { cause: error },
          );
        }
      }
      // The signal owner must finish stop; do not race fresh requests against it.
      if (processLoop && label === "original") {
        await processLoop;
      }
    }
    fs.writeFileSync(root + "/gateway-results.json", JSON.stringify(results, null, 2));
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  overlapProbe?.dispose();
  if (sibling) {
    process.send?.({ kind: "release-sibling" });
    const result = await sibling;
    fs.writeFileSync(root + "/sibling-result.json", JSON.stringify(result));
    console.log("SIBLING_RESULT " + JSON.stringify(result));
  }
  off();
  await server?.close({ reason: "isolated recovery reproduction complete" });
  process.disconnect?.();
  process.exit(process.exitCode ?? 0);
}
