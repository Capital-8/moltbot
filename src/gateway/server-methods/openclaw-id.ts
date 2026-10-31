// OpenClaw ID remote access methods. The link ceremony ("Make reachable") runs
// only for a direct-loopback client; relayed clients can read status and send
// owner-signed membership changes, which the authority verifies itself.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { Ed25519PublicKey } from "../../../packages/openclaw-id-protocol/src/index.js";
import { isEd25519PublicKey } from "../../../packages/openclaw-id-protocol/src/index.js";
import { resolveOpenClawIdClientChannel } from "../openclaw-id/channel.js";
import { decodeInviteProofKey } from "../openclaw-id/tunnel-api.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";

// Responds with the service, or an unavailable error when this Gateway has none.
function requireService(opts: GatewayRequestHandlerOptions) {
  const service = opts.context.openclawIdService;
  if (!service) {
    opts.respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, "OpenClaw ID is unavailable"),
    );
  }
  return service;
}

// Maps an authority refusal to an RPC error with a stable code in details.
function refuse(opts: GatewayRequestHandlerOptions, result: { code: string; detail: string }) {
  opts.respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, result.detail, { details: { code: result.code } }),
  );
}

function optionalCode(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export const openclawIdHandlers: GatewayRequestHandlers = {
  "openclawId.status": async (opts) => {
    const service = requireService(opts);
    if (!service) {
      return;
    }
    const config = opts.context.getRuntimeConfig().gateway?.openclawId;
    opts.respond(true, {
      status: service.status(),
      link: await service.linkStatus(),
      channel: resolveOpenClawIdClientChannel(opts.client) ?? null,
      services: {
        issuerUrl: config?.issuerUrl ?? null,
        discoveryUrl: config?.discoveryUrl ?? null,
        loaderDomain: config?.loaderDomain ?? null,
      },
    });
  },

  // Writes to the membership authority, by action:
  // - prepare / commit: the local link ceremony ("Make reachable"), direct loopback only;
  // - publish: (re)publish to Discovery, optionally with an enrollment code;
  // - submit: an owner-signed statement (MembershipChange, Revocation, root
  //   re-certification) sent directly over the tunnel or loopback. The authority
  //   verifies signature, chain, capability and seq; the mailbox never reaches here.
  //   Approving (`add` with invite_id) or denying (`deny_invite`) a pending
  //   redemption is a submit too;
  // - register_invite: an owner-signed InviteCap and its base64url proof key.
  "openclawId.authority": async (opts) => {
    const service = requireService(opts);
    if (!service) {
      return;
    }
    const params = isRecord(opts.params) ? opts.params : {};
    const channel = resolveOpenClawIdClientChannel(opts.client);
    if (params.action === "prepare") {
      const result = await service.prepareLink(channel);
      if ("ok" in result) {
        refuse(opts, result);
        return;
      }
      opts.respond(true, result);
      return;
    }
    if (params.action === "publish") {
      opts.respond(true, {
        publication: (await service.publish(optionalCode(params.enrollmentCode))) ?? null,
      });
      return;
    }
    if (params.action === "submit") {
      const result = await service.submitStatement(channel, params.statement);
      if (!result.ok) {
        refuse(opts, result);
        return;
      }
      opts.respond(true, { status: result.status, link: await service.linkStatus() });
      return;
    }
    if (params.action === "register_invite") {
      const proofKey = decodeInviteProofKey(params.proofKey);
      if (!params.cap || !proofKey) {
        refuse(opts, { code: "malformed", detail: "cap and a 32-byte proofKey are required" });
        return;
      }
      const result = await service.registerInvite(channel, { cap: params.cap, proofKey });
      if (!result.ok) {
        refuse(opts, result);
        return;
      }
      opts.respond(true, { status: result.status, link: await service.linkStatus() });
      return;
    }
    if (params.action !== "commit") {
      refuse(opts, {
        code: "malformed",
        detail: "action must be prepare, commit, publish, submit or register_invite",
      });
      return;
    }
    if (!isEd25519PublicKey(params.rootPub) || !params.ownerDevice || !params.binding) {
      refuse(opts, { code: "malformed", detail: "rootPub, ownerDevice and binding are required" });
      return;
    }
    const result = await service.commitLink(
      channel,
      {
        root_pub: params.rootPub as Ed25519PublicKey,
        owner_device: params.ownerDevice,
        binding: params.binding,
      },
      optionalCode(params.enrollmentCode),
    );
    if (!result.ok) {
      refuse(opts, result);
      return;
    }
    opts.respond(true, { linked: true, publication: result.publication ?? null });
  },
};
