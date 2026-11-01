// Isolated fixture, patterned on gateway-heartbeat-session-routing.e2e.test.ts.
// No sockets, HTTP clients, SDK send functions, credentials, or real provider fallback.
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const channel = "recovery-sink";
const target = /adopt-before-start|channel-run/.test(process.env.OC_REPRO_MODE ?? "")
  ? "user:U_INGRESS_REPRO"
  : "synthetic-r8-recipient";

function checkTarget(to, accountId) {
  if (to !== target || (accountId && accountId !== "default")) {
    throw new Error("Recovery sink accepts only its exact synthetic recipient/default account");
  }
}
async function recordText(params) {
  checkTarget(params.to, params.accountId);
  const root = process.env.OC_REPRO_ROOT;
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (
    !root ||
    !stateDir ||
    process.env.OC_REPRO_LIVE_SLACK === "1" ||
    !path.resolve(stateDir).startsWith(path.resolve(root) + path.sep)
  ) {
    throw new Error("Recovery sink requires the isolated non-live recovery fixture");
  }
  params.signal?.throwIfAborted();
  params.abortSignal?.throwIfAborted();
  await params.onPlatformSendDispatch?.();
  params.signal?.throwIfAborted();
  params.abortSignal?.throwIfAborted();
  params.assertDirectAdapterHandoff?.();
  const messageId = "recovery-sink-" + randomUUID();
  const sentAt = Date.now();
  // This append IS the fixture transport. Its receipt reports this local effect,
  // not a fictional Slack/Discord send and not a recovery/custody receipt.
  fs.appendFileSync(
    path.join(root, "recovery-sink-deliveries.jsonl"),
    JSON.stringify({
      messageId,
      sentAt,
      to: params.to,
      accountId: params.accountId ?? "default",
      text: params.text,
      deliveryQueueId: params.deliveryQueueId ?? null,
    }) + "\n",
  );
  return {
    channel,
    messageId,
    receipt: {
      primaryPlatformMessageId: messageId,
      platformMessageIds: [messageId],
      parts: [{ platformMessageId: messageId, kind: "text", index: 0 }],
      sentAt,
    },
  };
}
module.exports = {
  id: channel,
  register(api) {
    if (
      process.env.OC_REPRO_ROOT &&
      /adopt-before-start|channel-run/.test(process.env.OC_REPRO_MODE ?? "")
    ) {
      // Local fixture only. Pass the current Gateway binding to the in-process channel driver.
      api.registerGatewayMethod(
        "recovery-sink.fixtureScope",
        ({ context, respond }) => {
          const accepted = process.emit("openclaw:repro:channel-scope", context);
          respond(true, { accepted });
        },
        { scope: "operator.admin" },
      );
    }
    api.registerChannel({
      plugin: {
        id: channel,
        meta: {
          id: channel,
          label: "Recovery local sink",
          selectionLabel: "Recovery local sink",
          docsPath: "/channels/recovery-sink",
          blurb: "Isolated file-only recovery transport.",
        },
        capabilities: { chatTypes: ["direct"] },
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: (_cfg, accountId) => ({ accountId: accountId ?? "default" }),
          isEnabled: () => true,
          // The sink needs no external configuration or authentication.
          isConfigured: () => true,
        },
        outbound: {
          deliveryMode: "direct",
          resolveTarget: ({ to, accountId }) => {
            try {
              checkTarget(to, accountId);
              return { ok: true, to };
            } catch (error) {
              return { ok: false, error };
            }
          },
          sendText: recordText,
        },
        message: {
          id: channel,
          durableFinal: { capabilities: { text: true } },
          send: { text: recordText },
        },
      },
    });
  },
};
