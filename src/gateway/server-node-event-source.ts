import { isDeepStrictEqual } from "node:util";
import { safeParseJson } from "@openclaw/normalization-core/json-coercion";
import { asNullableObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getRuntimeConfig } from "../config/io.js";
import { getRuntimeConfigSnapshotMetadata } from "../config/runtime-snapshot.js";
import { acquireSessionActorStorage } from "../config/sessions/session-actor-storage-acquisition.js";
import {
  captureSessionActorStorageOwner,
  runWithSessionActorStorage,
} from "../config/sessions/session-actor-storage-binding.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../config/sessions/session-store-owner.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { normalizeSessionKeyPreservingOpaquePeerIds } from "../sessions/session-key-utils.js";
import { truncateUtf16WithEllipsis } from "../shared/text-truncate.js";
import type {
  NodeEvent,
  NodeEventContext,
  NodeEventHandlerOptions,
  NodeEventHandleResult,
} from "./server-node-events-types.js";
import { resolveSessionStoreIdentity } from "./session-store-key.js";
import { resolveSessionSubscriptionKey } from "./session-subscription-keys.js";
import { withGatewaySessionStoreTarget } from "./session-utils-store-lookup.js";
import type { GatewaySessionEntryRead } from "./session-utils-store.js";

export type NodeEventSessionSource = {
  loaded: GatewaySessionEntryRead;
  assertCurrent(this: void): void;
  pending: Promise<unknown>[];
};

export async function isNodeEventConnectionCurrent(opts?: {
  isConnectionCurrent?: () => boolean | Promise<boolean>;
}): Promise<boolean> {
  if (!opts?.isConnectionCurrent) {
    return true;
  }
  try {
    return await opts.isConnectionCurrent();
  } catch {
    return false;
  }
}

export function pairingChangedResult(event: string): NodeEventHandleResult {
  return { ok: true, event, handled: false, reason: "pairing_changed" };
}

export function parseNodeEventPayload(payloadJSON?: string | null): Record<string, unknown> | null {
  return payloadJSON ? asNullableObjectRecord(safeParseJson(payloadJSON)) : null;
}

export function compactNodeEventText(raw: string, maxChars: number) {
  return truncateUtf16WithEllipsis(raw.replace(/\s+/g, " ").trim(), maxChars);
}

export function captureNodeEventConfig() {
  const cfg = getRuntimeConfig();
  const publication = getRuntimeConfigSnapshotMetadata();
  return {
    cfg,
    assertCurrent: () => {
      if (getRuntimeConfigSnapshotMetadata() !== publication) {
        throw new Error("Node event configuration changed during preparation");
      }
    },
  };
}

/** Admit legacy node selectors once; the subscription owns their logical target until removal. */
export async function handleNodeChatSubscription(
  ctx: NodeEventContext,
  nodeId: string,
  evt: NodeEvent,
  opts?: NodeEventHandlerOptions,
): Promise<NodeEventHandleResult | undefined> {
  const sessionKey = normalizeOptionalString(parseNodeEventPayload(evt.payloadJSON)?.sessionKey);
  if (!sessionKey) {
    return undefined;
  }
  const { cfg, assertCurrent } = captureNodeEventConfig();
  const qualifiedGlobal = parseAgentSessionKey(sessionKey)?.rest.toLowerCase() === "global";
  const { agentId, canonicalKey } = resolveSessionStoreIdentity({
    cfg,
    sessionKey,
    preserveQualifiedAddress: qualifiedGlobal,
  });
  const method = evt.event === "chat.subscribe" ? "nodeSubscribe" : "nodeUnsubscribe";
  if (!qualifiedGlobal && canonicalKey !== "global") {
    await ctx[method](nodeId, canonicalKey, opts?.connId);
    return undefined;
  }
  let subscriptionKey = resolveSessionSubscriptionKey(canonicalKey, agentId);
  const rawOwner = resolvePersistedSessionStoreOwnerForKey(cfg, "global");
  if (
    qualifiedGlobal &&
    method === "nodeSubscribe" &&
    (rawOwner.kind === "none" || (rawOwner.kind === "configured" && rawOwner.agentId === agentId))
  ) {
    subscriptionKey = await withGatewaySessionStoreTarget(
      {
        cfg,
        key: canonicalKey,
        agentId,
        preserveQualifiedAddress: true,
        projection: "list",
        relatedKeys: [{ key: "global", agentId }],
      },
      (literal, _membership, assertReadCurrent, [raw]) => {
        assertCurrent();
        assertReadCurrent();
        return !literal.store[canonicalKey] &&
          raw?.store.global &&
          raw.readSource?.agentId === agentId
          ? resolveSessionSubscriptionKey("global", agentId)
          : canonicalKey;
      },
    );
    if (!(await isNodeEventConnectionCurrent(opts))) {
      return pairingChangedResult(evt.event);
    }
  }
  await ctx[method](
    nodeId,
    subscriptionKey,
    opts?.connId,
    normalizeSessionKeyPreservingOpaquePeerIds(sessionKey),
  );
  return undefined;
}

/** Keep prepared private authority and every accepted consumer with the captured actor. */
export async function withNodeEventSessionSource(
  evt: NodeEvent,
  opts: NodeEventHandlerOptions | undefined,
  consume: (
    opts: NodeEventHandlerOptions | undefined,
    source?: NodeEventSessionSource,
  ) => Promise<NodeEventHandleResult | undefined>,
): Promise<NodeEventHandleResult | undefined> {
  const requestedKey = ["voice.transcript", "agent.request", "notifications.changed"].includes(
    evt.event,
  )
    ? normalizeOptionalString(parseNodeEventPayload(evt.payloadJSON)?.sessionKey)
    : undefined;
  const namespace = requestedKey
    ? captureSessionActorStorageOwner(
        { sessionKey: requestedKey },
        { assertCurrent() {}, authorize() {} },
      )
    : undefined;
  if (!namespace || !requestedKey) {
    return consume(opts);
  }
  if (!(await isNodeEventConnectionCurrent(opts))) {
    return pairingChangedResult(evt.event);
  }
  const binding = await acquireSessionActorStorage(
    { sessionKey: requestedKey },
    {
      lifetime: {
        assertCurrent: () => namespace.authority.assertCurrent(),
        assertReadable: () => namespace.authority.assertCurrent(),
      },
      authority: namespace.authority,
    },
  );
  if (!binding) {
    return { ok: true, event: evt.event, handled: false, reason: "session_missing" };
  }
  try {
    return await runWithSessionActorStorage(binding, async () => {
      const entry = binding.actor.snapshot(binding.authority)?.entry;
      if (!entry) {
        return { ok: true, event: evt.event, handled: false, reason: "session_missing" } as const;
      }
      const assertCurrent = () => {
        const current = binding.actor.snapshot(binding.authority)?.entry;
        if (
          current?.agentHarnessId !== entry.agentHarnessId ||
          !isDeepStrictEqual(current?.delivery, entry.delivery)
        ) {
          throw new Error("Node event session authority changed");
        }
      };
      const pending: Promise<unknown>[] = [];
      try {
        return await consume(
          {
            ...opts,
            isConnectionCurrent: async () => {
              const current = await isNodeEventConnectionCurrent(opts);
              assertCurrent();
              return current;
            },
          },
          {
            loaded: {
              cfg: getRuntimeConfig(),
              agentId: binding.agentId,
              storePath: binding.path,
              canonicalKey: requestedKey,
              storeKeys: [requestedKey],
              store: { [requestedKey]: entry },
              legacyKey: undefined,
              entry,
            },
            assertCurrent,
            pending,
          },
        );
      } finally {
        for (const work of pending) {
          await Promise.allSettled([work]);
        }
      }
    });
  } finally {
    await binding.actor.release();
  }
}

export function pruneBoundedTimestampMap(
  map: Map<string, number>,
  params: { now: number; ttlMs: number; maxEntries: number },
) {
  if (map.size <= params.maxEntries) {
    return;
  }
  const cutoff = params.now - params.ttlMs;
  for (const [key, ts] of map) {
    if (ts < cutoff) {
      map.delete(key);
    }
    if (map.size <= params.maxEntries) {
      return;
    }
  }
  pruneMapToMaxSize(map, params.maxEntries);
}
