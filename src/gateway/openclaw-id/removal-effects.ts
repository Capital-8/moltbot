// Removal side effects (spec section 7): when a member or device key is
// removed, its relayed Gateway connections are found and closed and its device
// tokens revoked.
import { revokeDeviceToken } from "../../infra/device-pairing-tokens.js";
import { invalidateGatewayPolicyClient } from "../server/ws-policy-close.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import type { OpenClawIdEffects } from "./service.js";

type EffectsLogger = { warn: (message: string) => void };

/** Builds the effects over the Gateway's live client registry. */
export function createOpenClawIdRemovalEffects(params: {
  clients: () => Iterable<GatewayWsClient>;
  log: EffectsLogger;
}): OpenClawIdEffects {
  const byConnection = new Map<string, GatewayWsClient>();
  return {
    captureConnections(peerKeys) {
      const ids: string[] = [];
      for (const client of params.clients()) {
        const peerKey = client.internal?.openclawIdPeerKey;
        if (peerKey && peerKeys.includes(peerKey)) {
          ids.push(client.connId);
          byConnection.set(client.connId, client);
        }
      }
      return ids;
    },

    closeConnections(connectionIds) {
      for (const id of connectionIds) {
        const client = byConnection.get(id);
        byConnection.delete(id);
        if (client) {
          invalidateGatewayPolicyClient(client, {
            reason: "openclaw-id-removed",
            code: 1008,
            message: "removed from this claw",
          });
        }
      }
    },

    async revokeDeviceTokens(tokens) {
      for (const token of tokens) {
        try {
          await revokeDeviceToken({ deviceId: token.deviceId, role: token.role });
        } catch (error) {
          params.log.warn(`openclaw-id: could not revoke a device token: ${String(error)}`);
        }
      }
    },
  };
}
