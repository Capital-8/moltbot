import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { buildChannelSourceTurnId } from "../../../src/auto-reply/reply/source-turn-id.ts";
import { readSessionEntryInWorker } from "../../../src/config/sessions/session-entry-read-runtime.ts";
import type { startGatewayServer } from "../../../src/gateway/server.ts";
import { readVisibleSessionTranscriptMessageEntries } from "../../../src/plugin-sdk/session-transcript-runtime.ts";
import { getGatewayRestartDrainSignal } from "../../../src/process/gateway-work-admission.ts";
import { sendChannelFixtureText } from "./ingress-channel-fixture.mts";
import { startFixtureGateway } from "./start-fixture-gateway.mts";

// This is a local channel-admission boundary probe. The external Slack receiver,
// routing and authorization are not exercised here; ingress.test.ts owns ACK proof.
// It never seeds a session/recovery/native receipt. getReplyFromConfig creates them.
const root = process.env.OC_REPRO_ROOT;
const stateDir = process.env.OPENCLAW_STATE_DIR;
assert.ok(root && stateDir, "isolated reproduction directories are required");
assert.notEqual(process.env.OC_REPRO_GATEWAY_PHASE, "recovered", "use the normal entry on restart");
assert.ok(
  typeof process.send === "function",
  "the parent must own the crash and replacement process",
);
const target = {
  agentId: "main",
  sessionKey: "agent:main:main",
  storePath: path.join(stateDir, "agents/main/sessions/sessions.json"),
};
const messageId = "1793124727.000001";
const channel =
  process.env.OC_REPRO_EXPECT_RECOVERED === "1" ||
  process.env.OC_REPRO_MODE?.includes("live-handoff")
    ? "recovery-sink"
    : "slack";
const conversationId = "user:U_INGRESS_REPRO";
const accountId = "default";
const sourceTurnId = buildChannelSourceTurnId({
  provider: channel,
  accountId,
  conversationId,
  messageId,
});
assert.ok(sourceTurnId);
const prompt = "Reply with RECOVERY_OK. INGRESS_ADOPTED_BEFORE_NATIVE synthetic request.";
let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
let processLoop: Promise<void> | undefined;
let reachedAdoption = false;
try {
  const port = Number(process.env.OC_REPRO_GATEWAY_PORT);
  assert.ok(Number.isInteger(port) && port > 0, "parent-owned Gateway port is required");
  ({ server, processLoop } = await startFixtureGateway(port));
  await sendChannelFixtureText(
    { port, channel, sessionKey: target.sessionKey, text: prompt, messageId },
    {
      disableBlockStreaming: true,
      // Only the channel host can authorize a notice for its accepted source.
      allowRestartRecoveryFailureNotice:
        process.env.OC_REPRO_MODE?.endsWith("-notify-failure") === true,
      turnAdoptionLifecycle: {
        admission: "exclusive",
        onAdopted: async () => {
          reachedAdoption = true;
          const entry = await readSessionEntryInWorker(target, () => {
            assert.ok(server, "fixture Gateway must remain active while reading adoption");
          });
          assert.ok(entry, "real admission must create the session");
          assert.equal(entry.status, "running");
          assert.equal(entry.restartRecoveryBeforeAgentReplyState, "undispatched-v1");
          assert.equal(entry.restartRecoverySourceIngress, "channel");
          assert.equal(entry.restartRecoveryDeliverySourceRunId, sourceTurnId);
          assert.ok(entry.restartRecoveryDeliveryRunId);
          const transcript = await readVisibleSessionTranscriptMessageEntries({
            ...target,
            sessionId: entry.sessionId,
          });
          const sourceUsers = transcript.filter(({ message }) => {
            const record = asOptionalRecord(message);
            return record?.role === "user" && record.idempotencyKey === sourceTurnId;
          });
          assert.equal(sourceUsers.length, 1, "real source transcript must commit before adoption");
          const receipt = {
            scenario: "adopt-before-native-start",
            seeded: false,
            scope: "local getReplyFromConfig channel admission; external receiver not exercised",
            sessionKey: target.sessionKey,
            sessionId: entry.sessionId,
            runId: entry.restartRecoveryDeliveryRunId,
            sourceTurnId,
            status: entry.status,
            sourceUserCount: sourceUsers.length,
            deliveryContext: entry.restartRecoveryDeliveryContext,
            gatewayPid: process.pid,
          };
          fs.writeFileSync(
            root + "/ingress-adopted-before-native.json",
            JSON.stringify(receipt, null, 2),
          );
          fs.writeFileSync(
            root + "/interrupted-request.json",
            JSON.stringify({
              label: "original",
              runId: receipt.runId,
              error: "crash after real channel adoption before native start",
            }),
          );
          if (process.env.OC_REPRO_MODE?.includes("channel-run")) {
            return; // The parent intercepts the actual in-flight model/tool boundary.
          }
          await new Promise<void>((resolve, reject) => {
            process.send?.({ kind: "ingress-adopted-before-native", ...receipt }, (error) => {
              if (error) {
                reject(error);
              } else {
                resolve();
              }
            });
          });
          // Holding the actual adoption callback prevents before-reply hooks and
          // runtime dispatch. Parent must assert zero native turn/start requests,
          // SIGKILL only this child, then start the normal Gateway on the same state.
          await new Promise<never>(() => {});
        },
      },
    },
  );
  if (processLoop && getGatewayRestartDrainSignal().aborted) {
    await processLoop;
  } else {
    throw new Error("channel reply settled without the crash barrier");
  }
} catch (error) {
  if (processLoop && getGatewayRestartDrainSignal().aborted) {
    await processLoop;
  }
  fs.writeFileSync(
    root + "/ingress-continuity-error.json",
    JSON.stringify({ reachedAdoption, error: String(error) }, null, 2),
  );
  console.error(error);
  process.exitCode = 1;
} finally {
  await server?.close({ reason: "isolated ingress continuity probe complete" });
  process.disconnect?.();
  process.exit(process.exitCode ?? 0);
}
