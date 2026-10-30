import {
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
  toAgentStoreSessionKey,
} from "../routing/session-key.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { emitHeartbeatEvent } from "./heartbeat-events.js";

const stores = resolveGlobalSingleton<{
  resolve?: (sessionKey: string, agentId?: string) => string;
  prepare?: (sessionKey: string, agentId?: string) => Promise<string>;
  owners: Map<symbol, () => void>;
}>(
  Symbol.for("openclaw.systemEventStores"),
  () => ({ owners: new Map() }),
  () => {
    stores.resolve = undefined;
    stores.prepare = undefined;
  },
  "close-only",
);

export function getSystemEventStorePath(sessionKey: string, agentId?: string): string | undefined {
  try {
    const target = readSystemEventQueueIdentity(sessionKey);
    return stores.resolve?.(target?.sessionKey ?? sessionKey, target?.agentId ?? agentId);
  } catch {
    return undefined;
  }
}

/** Prepare the current owner's path without invoking its synchronous discovery fallback. */
export function prepareSystemEventStorePath(
  sessionKey: string,
  agentId?: string,
): Promise<string> | undefined {
  const resolve = stores.resolve;
  if (!resolve) {
    return undefined;
  }
  const target = readSystemEventQueueIdentity(sessionKey);
  const key = target?.sessionKey ?? sessionKey;
  const owner = target?.agentId ?? agentId;
  const preparing = stores.prepare
    ? stores.prepare(key, owner)
    : Promise.resolve(resolve(key, owner));
  return preparing.then((pathname) => {
    if (stores.resolve !== resolve) {
      throw new Error("System-event store owner changed during path preparation");
    }
    return pathname;
  });
}

export function isSystemEventStoreCurrent(
  sessionKey: string | undefined,
  storePath: string | null | undefined,
  agentId?: string,
): boolean {
  return (
    !sessionKey ||
    (storePath !== null &&
      (!stores.resolve ||
        (storePath !== undefined && storePath === getSystemEventStorePath(sessionKey, agentId))))
  );
}

/** A resumed operation must not discover a replacement owner's store on the host. */
export function captureSystemEventStoreCurrentCheck(sessionKey: string, agentId?: string) {
  const resolve = stores.resolve;
  return (storePath: string | null | undefined) =>
    stores.resolve === resolve && isSystemEventStoreCurrent(sessionKey, storePath, agentId);
}

/** The accepted Gateway store selection owns retirement; same-store handoff retains its facts. */
export function publishSystemEventStoreResolver(
  resolve: typeof stores.resolve,
  prepare?: typeof stores.prepare,
): void {
  stores.resolve = resolve;
  stores.prepare = prepare;
  for (const retire of stores.owners.values()) {
    retire();
  }
}

export function registerSystemEventStoreOwner(key: symbol, retire: () => void): void {
  stores.owners.set(key, retire);
}

export function recordSystemEventStoreReplaced(): void {
  emitHeartbeatEvent({
    status: "skipped",
    reason: "store-replaced",
    message: "Dropped: session store replaced.",
  });
}

/** Queue identity is scoped without rewriting the caller's persisted session key. */
export function resolveSystemEventQueueKey(sessionKey: string, agentId?: string): string {
  if (!sessionKey.trim()) {
    throw new Error("system events require a sessionKey");
  }
  const owner = resolveAgentIdFromSessionKey(sessionKey, agentId);
  if (agentId && owner !== normalizeAgentId(agentId)) {
    throw new Error("System event owner does not match its session key.");
  }
  return sessionKey.trim().toLowerCase() === "global"
    ? JSON.stringify([owner, "global"])
    : toAgentStoreSessionKey({ agentId: owner, requestKey: sessionKey });
}

/** Recover real owner facts from the ephemeral queue index before any store operation. */
export function readSystemEventQueueIdentity(key: string) {
  if (key.startsWith("[")) {
    try {
      const tuple: unknown = JSON.parse(key);
      if (
        Array.isArray(tuple) &&
        tuple.length === 2 &&
        typeof tuple[0] === "string" &&
        tuple[0] === normalizeAgentId(tuple[0]) &&
        tuple[1] === "global"
      ) {
        return { agentId: tuple[0], sessionKey: "global" };
      }
    } catch {
      /* Invalid queue keys are rejected by their admission owner. */
    }
    return undefined;
  }
  const parsed = parseAgentSessionKey(key);
  return parsed
    ? { agentId: parsed.agentId, sessionKey: `agent:${parsed.agentId}:${parsed.rest}` }
    : undefined;
}

export function withSystemEventOwner<T extends { sessionKey: string }>(
  options: T,
  agentId: string,
): Omit<T, "sessionKey"> & { sessionKey: string } {
  return { ...options, sessionKey: resolveSystemEventQueueKey(options.sessionKey, agentId) };
}
