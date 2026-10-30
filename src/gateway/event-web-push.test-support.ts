import { GatewayClientRegistry } from "./server/client-registry.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import {
  createSessionViewerPresenceDeclarations,
  type SessionViewerPresenceDeclarations,
} from "./session-viewer-presence.js";

export const researchContext = { agentId: "research", sessionKeys: ["agent:research:thread.1"] };

export type Viewers = {
  declarations: SessionViewerPresenceDeclarations;
  view: (
    deviceId: string | undefined,
    sessionKeys?: readonly string[],
    exactKeys?: readonly string[],
  ) => GatewayWsClient;
};

export function createViewers(): Viewers {
  const clients = new GatewayClientRegistry();
  const declarations = createSessionViewerPresenceDeclarations({
    clients,
    publishPresence: () => {},
  });
  const view: Viewers["view"] = (deviceId, sessionKeys, exactKeys) => {
    const client: GatewayWsClient = {
      connId: `conn-${deviceId ?? "anonymous"}`,
      usesSharedGatewayAuth: false,
      socket: { readyState: 1 } as GatewayWsClient["socket"],
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        role: "operator",
        client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
        ...(deviceId
          ? {
              device: { id: deviceId, publicKey: "key", signature: "sig", signedAt: 1, nonce: "n" },
            }
          : {}),
      },
    };
    clients.add(client);
    declarations.replace(client.connId, sessionKeys ?? researchContext.sessionKeys, exactKeys);
    return client;
  };
  return { declarations, view };
}
