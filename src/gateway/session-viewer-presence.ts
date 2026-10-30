// Per-connection viewer presence declarations. Message subscriptions are transport state,
// while this replace-set records only the sessions a client is actually rendering.
import { normalizeOptionalString } from "@openclaw/normalization-core";
import { upsertPresence } from "../infra/system-presence.js";
import { presenceUserKey } from "../shared/presence-user.js";
import { WEBSOCKET_OPEN_READY_STATE } from "./server-constants.js";
import { recordClientPresenceActivity, snapshotClientPresence } from "./server/client-presence.js";
import type { GatewayClientRegistry } from "./server/client-registry.js";

type SessionViewerPresenceDeclarationsDeps = {
  clients: GatewayClientRegistry;
  publishPresence: () => void;
};

/** Owns one replace-set per websocket connection until empty declaration or disconnect. */
export function createSessionViewerPresenceDeclarations(
  deps: SessionViewerPresenceDeclarationsDeps,
) {
  const declarations = new Map<
    string,
    {
      sessionKeys: readonly string[];
      exactKeys: ReadonlySet<string>;
    }
  >();
  let stopped = false;

  const replace = (
    connId: string,
    sessionKeys: readonly string[],
    exactKeys?: readonly string[],
  ): readonly string[] => {
    if (stopped) {
      return [];
    }
    const normalizedConnId = connId.trim();
    const client = deps.clients.getByConnectionId(normalizedConnId);
    if (!client || client.invalidated || client.socket.readyState !== WEBSOCKET_OPEN_READY_STATE) {
      return [];
    }
    const next = [...new Set(sessionKeys.map((key) => key.trim()).filter(Boolean))].toSorted();
    const previous = declarations.get(normalizedConnId)?.sessionKeys ?? [];
    // Equal public hints can represent a switch between distinct stored global rows.
    if (next.length === 0) {
      declarations.delete(normalizedConnId);
    } else {
      declarations.set(normalizedConnId, {
        sessionKeys: next,
        exactKeys: new Set(exactKeys ?? next),
      });
    }
    if (previous.length === next.length && previous.every((key, index) => key === next[index])) {
      return next;
    }
    if (client.presenceKey) {
      upsertPresence(client.presenceKey, {
        watchedSessions: next.length > 0 ? [...next] : undefined,
      });
      if (next.length > 0) {
        recordClientPresenceActivity(deps.clients, client);
      }
      deps.publishPresence();
    }
    return next;
  };

  const unsubscribe = (connId: string) => {
    const normalizedConnId = connId.trim();
    if (normalizedConnId) {
      // The websocket close boundary publishes reason=disconnect and clears watchedSessions.
      // Delete here first so a recycled connection id can never inherit an old declaration.
      declarations.delete(normalizedConnId);
    }
  };

  /** True only while an open connection of this paired device currently renders the session. */
  const isViewedOnDevice = (deviceId: string, sessionKey: string): boolean => {
    for (const [connId, { exactKeys }] of declarations) {
      if (!exactKeys.has(sessionKey)) {
        continue;
      }
      const client = deps.clients.getByConnectionId(connId);
      if (
        client &&
        !client.invalidated &&
        !client.connectionSignal?.aborted &&
        client.socket.readyState === WEBSOCKET_OPEN_READY_STATE &&
        normalizeOptionalString(client.connect.device?.id) === deviceId
      ) {
        return true;
      }
    }
    return false;
  };

  const liveViewerIdentities = (subscriptionKey: string): Set<string> => {
    const viewers = new Set(
      [...declarations].flatMap(([connId, { exactKeys }]) => {
        const client = exactKeys.has(subscriptionKey)
          ? deps.clients.getByConnectionId(connId)
          : undefined;
        return client && !client.connectionSignal?.aborted ? [client] : [];
      }),
    );
    return new Set(
      snapshotClientPresence(viewers).flatMap(({ user }) =>
        user?.id ? [presenceUserKey(user)] : [],
      ),
    );
  };

  const stop = () => {
    stopped = true;
    declarations.clear();
  };

  return { replace, unsubscribe, isViewedOnDevice, liveViewerIdentities, stop };
}

export type SessionViewerPresenceDeclarations = ReturnType<
  typeof createSessionViewerPresenceDeclarations
>;
