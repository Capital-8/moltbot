import assert from "node:assert/strict";
import { getReplyFromConfig } from "../../../src/auto-reply/reply/get-reply.ts";
import { callGateway } from "../../../src/gateway/call.ts";
import type { GatewayRequestContext } from "../../../src/gateway/server-methods/types.ts";
import { withPluginRuntimeGatewayContextResolver } from "../../../src/plugins/runtime/gateway-request-scope.ts";

/** Enter the registered fixture Gateway with the channel user's original identity. */
export async function sendChannelFixtureText(
  input: { port: number; channel: string; sessionKey: string; text: string; messageId: string },
  options: Parameters<typeof getReplyFromConfig>[1],
) {
  let resolver: GatewayRequestContext["resolveGatewayContext"];
  if (input.channel === "recovery-sink") {
    process.once("openclaw:repro:channel-scope", (owner: GatewayRequestContext) => {
      resolver = owner.resolveGatewayContext;
    });
    const result = await callGateway<{ accepted: boolean }>({
      url: `ws://127.0.0.1:${input.port}`,
      token: "synthetic-gateway-token",
      method: "recovery-sink.fixtureScope",
      params: {},
      timeoutMs: 10000,
    });
    assert.ok(result.accepted && resolver?.(), "fixture requires the serving Gateway");
  }
  const to = "user:U_INGRESS_REPRO";
  return await withPluginRuntimeGatewayContextResolver(resolver, () =>
    getReplyFromConfig(
      {
        Body: input.text,
        BodyForAgent: input.text,
        From: to,
        To: to,
        SessionKey: input.sessionKey,
        Provider: input.channel,
        Surface: input.channel,
        ChatType: "direct",
        OriginatingChannel: input.channel,
        OriginatingTo: to,
        AccountId: "default",
        SenderId: "U_INGRESS_REPRO",
        MessageSid: input.messageId,
        CommandAuthorized: false,
      },
      options,
    ),
  );
}
