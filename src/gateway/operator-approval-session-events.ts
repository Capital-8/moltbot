import { normalizeOptionalString } from "@openclaw/normalization-core";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  PendingApprovalSnapshot,
  SessionApprovalEvent,
  SessionApprovalReplay,
} from "../../packages/gateway-protocol/src/index.js";
import { getSubagentSessionListReadSnapshotIdentity } from "../agents/subagents/registry/subagent-registry-state.js";
import { withSessionEntriesFromStoreInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { resolveSessionStorePathForScope } from "../config/sessions/session-store-path.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import {
  resolveApprovalSessionAudienceWithFallback,
  resolveApprovalSourceStreamKey,
} from "./approval-session-audience.js";
import { normalizeControlUiBasePath } from "./control-ui-shared.js";
import type {
  ExecApprovalManager,
  OperatorApprovalLifecycleEvent,
} from "./exec-approval-manager.js";
import { ADMIN_SCOPE } from "./method-scopes.js";
import {
  canAccessOperatorApproval,
  canReviewOperatorApproval,
} from "./operator-approval-authorization.js";
import { matchesOperatorApprovalReviewerBinding } from "./operator-approval-reviewer-binding.js";
import { projectOperatorApprovalSnapshot } from "./operator-approval-snapshot.js";
import {
  listPendingOperatorApprovals,
  prepareOperatorApprovalReplay,
  type OperatorApprovalRecord,
} from "./operator-approval-store.js";
import type { GatewayBroadcastToConnIdsFn } from "./server-broadcast-types.js";
import type { SessionMessageSubscriberRegistry } from "./server-chat-state.js";
import type { GatewayClient, PreparedSessionApprovalReplay } from "./server-methods/types.js";
import { resolveSessionSubscriptionKey } from "./session-subscription-keys.js";

const MAX_SESSION_APPROVAL_REPLAY = 1_000;
const MAX_IDLE_REPLAY_SCOPES = 64;
type ApprovalReplaySnapshot = Omit<PreparedSessionApprovalReplay, "release"> & {
  reusable: boolean;
};
type ApprovalReplayScope = {
  sessionKey: string;
  selection?: { sessionKey: string; agentId: string };
  reviewerDeviceId: string | undefined;
  references: number;
  revision: number;
  preparation?: Promise<ApprovalReplaySnapshot>;
  completed?: ApprovalReplaySnapshot;
};

type OperatorApprovalSessionEventRuntime = {
  publish: (event: OperatorApprovalLifecycleEvent) => void;
  replay: (
    sessionKey: string,
    client: GatewayClient | null,
    selection?: { sessionKey: string; agentId: string },
  ) => Promise<PreparedSessionApprovalReplay>;
};

function resolveApprovalSourceStreamKeyForRecord(record: OperatorApprovalRecord): string | null {
  return (
    record.audienceSessionKeys[0] ??
    (record.source.sessionKey
      ? resolveApprovalSourceStreamKey(record.source.sessionKey, record.source.agentId)
      : null)
  );
}

function matchesApprovalSource(
  request: unknown,
  source: OperatorApprovalRecord["source"],
): boolean {
  const value = asOptionalObjectRecord(request);
  return (
    (normalizeOptionalString(value?.runId) ?? null) === source.runId &&
    (normalizeOptionalString(value?.sessionId) ?? null) === source.sessionId &&
    (normalizeOptionalString(value?.sessionKey) ?? null) === source.sessionKey
  );
}

/** Project durable approval truth to exact, explicitly opted-in session audiences. */
export function createOperatorApprovalSessionEventRuntime(params: {
  clients: Iterable<GatewayClient>;
  track: (run: () => Promise<void>) => Promise<void>;
  onError?: (error: unknown) => void;
  sessionMessageSubscribers: Pick<SessionMessageSubscriberRegistry, "getApprovals">;
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  controlUiBasePath?: string;
  reconcileTerminal?: (record: OperatorApprovalRecord) => boolean | Promise<boolean>;
  getLiveManager?: (
    kind: OperatorApprovalRecord["kind"],
  ) =>
    | Pick<ExecApprovalManager<unknown>, "runtimeEpoch" | "getLiveSnapshot" | "isPending">
    | undefined;
  isCurrent?: () => boolean;
}): OperatorApprovalSessionEventRuntime {
  const controlUiBasePath = normalizeControlUiBasePath(params.controlUiBasePath);
  const replayScopes = new Map<string, ApprovalReplayScope>();
  const idleScopes = new Map<string, ApprovalReplayScope>();

  const authorizedRecipients = (
    sessionKey: string,
    record: OperatorApprovalRecord,
    includeRawGlobal = true,
  ): ReadonlySet<string> => {
    const parsed = parseAgentSessionKey(sessionKey);
    const subscribed = new Set(params.sessionMessageSubscribers.getApprovals(sessionKey));
    if (includeRawGlobal && parsed?.rest === "global") {
      for (const connId of params.sessionMessageSubscribers.getApprovals(
        resolveSessionSubscriptionKey("global", parsed.agentId),
      )) {
        subscribed.add(connId);
      }
    }
    if (subscribed.size === 0) {
      return subscribed;
    }
    const recipients = new Set<string>();
    for (const client of params.clients) {
      const connId = client.connId;
      if (
        !client.invalidated &&
        connId &&
        subscribed.has(connId) &&
        canAccessOperatorApproval({ client, binding: record })
      ) {
        recipients.add(connId);
      }
    }
    return recipients;
  };

  const publish = (event: OperatorApprovalLifecycleEvent): void => {
    for (const [key, scope] of replayScopes) {
      if (
        event.record.audienceSessionKeys.includes(scope.sessionKey) &&
        (scope.reviewerDeviceId === undefined ||
          matchesOperatorApprovalReviewerBinding(event.record, scope.reviewerDeviceId))
      ) {
        scope.revision += 1;
        scope.preparation = undefined;
        scope.completed = undefined;
        if (scope.references === 0) {
          idleScopes.delete(key);
          replayScopes.delete(key);
        }
      }
    }
    const source = event.record.source;
    const pending = event.phase === "pending" && event.record.status === "pending";
    const manager = params.getLiveManager?.(event.record.kind);
    const live = pending ? manager?.getLiveSnapshot(event.record.id) : undefined;
    const livePending = Boolean(
      manager?.runtimeEpoch === event.record.runtimeEpoch &&
      live &&
      live.resolvedAtMs === undefined &&
      live.expiresAtMs > Date.now() &&
      matchesApprovalSource(live.request, source),
    );
    if (
      params.getLiveManager &&
      params.isCurrent?.() !== false &&
      source.runId &&
      source.sessionId &&
      (pending ? livePending : event.record.status !== "pending")
    ) {
      // Only the approval owner emits these transitions. Tool-result approval
      // text can arrive after resolution and cannot re-open an attention request.
      emitAgentEvent({
        runId: source.runId,
        sessionId: source.sessionId,
        ...(source.sessionKey ? { sessionKey: source.sessionKey } : {}),
        stream: "execution",
        data: { approval: { id: event.record.id, state: pending ? "pending" : "resolved" } },
      });
    }
    const approval = projectOperatorApprovalSnapshot(event.record, controlUiBasePath);
    if (!approval || event.record.audienceSessionKeys.length === 0) {
      return;
    }
    // The audience walk seeds the fully canonicalized source stream key as its
    // first entry; publish that exact form so parents can correlate the event
    // with a stream key they subscribed to. Raw source aliases (bare "global",
    // "main", unscoped child keys) never reach subscribers.
    const sourceStreamKey = resolveApprovalSourceStreamKeyForRecord(event.record);
    for (const sessionKey of event.record.audienceSessionKeys) {
      const recipients = authorizedRecipients(sessionKey, event.record);
      if (recipients.size === 0) {
        continue;
      }
      const common = {
        sessionKey,
        ...(sourceStreamKey ? { sourceSessionKey: sourceStreamKey } : {}),
        updatedAtMs: event.record.updatedAtMs,
      };
      let payload: SessionApprovalEvent;
      if (event.phase === "pending") {
        if (approval.status !== "pending") {
          continue;
        }
        payload = { ...common, phase: "pending", approval };
      } else {
        if (approval.status === "pending") {
          continue;
        }
        payload = { ...common, phase: "terminal", approval };
      }
      const parsed = parseAgentSessionKey(sessionKey);
      if (parsed?.rest !== "global") {
        params.broadcastToConnIds("session.approval", payload, recipients);
        continue;
      }
      const send = (selectedKey?: string) => {
        if (
          params.isCurrent?.() === false ||
          (pending && (!livePending || !live || !manager?.isPending(live)))
        ) {
          return;
        }
        if (selectedKey) {
          const currentRecipients = authorizedRecipients(
            sessionKey,
            event.record,
            selectedKey !== sessionKey,
          );
          params.broadcastToConnIds("session.approval", payload, currentRecipients, {
            sessionKeys: [selectedKey],
            agentId: parsed.agentId,
            sessionSubscriptionKeys:
              selectedKey === "global"
                ? [resolveSessionSubscriptionKey("global", parsed.agentId), sessionKey]
                : [sessionKey],
          });
        } else {
          // Each hint retains its real read scope; neither audience needs sibling access.
          for (const targetKey of ["global", sessionKey]) {
            const subscriptionKey = resolveSessionSubscriptionKey(targetKey, parsed.agentId);
            const hintRecipients = authorizedRecipients(subscriptionKey, event.record, false);
            if (hintRecipients.size > 0) {
              params.broadcastToConnIds(
                "sessions.changed",
                { sessionKey: targetKey, agentId: parsed.agentId, reason: "approval" },
                hintRecipients,
                { sessionKeys: [targetKey], agentId: parsed.agentId },
              );
            }
          }
        }
      };
      void params
        .track(async () => {
          try {
            await withSessionEntriesFromStoreInWorker(
              {
                agentId: parsed.agentId,
                sessionKeys: ["global", sessionKey],
                storePath: resolveSessionStorePathForScope({ agentId: parsed.agentId }),
                projection: "sharing",
                includeAuthorization: true,
              },
              async ({ result, database, assertCurrent }) => {
                const keys = new Set(
                  [...result.entries, ...(result.sharing?.placeholders ?? [])].map(
                    (row) => row.sessionKey,
                  ),
                );
                const known =
                  result.sharing?.source.agentId === database.agentId &&
                  result.sharing?.source.path === database.path;
                const raw = database.agentId === parsed.agentId && keys.has("global");
                const literal = keys.has(sessionKey);
                assertCurrent();
                send(known && raw !== literal ? (raw ? "global" : sessionKey) : undefined);
              },
            );
          } catch {
            send();
          }
        })
        .catch((error: unknown) => params.onError?.(error));
    }
  };

  const prepareReplay = async (scope: ApprovalReplayScope): Promise<ApprovalReplaySnapshot> => {
    const { sessionKey, reviewerDeviceId, selection } = scope;
    const exactGlobal =
      selection &&
      (selection.sessionKey === "global" ||
        parseAgentSessionKey(selection.sessionKey)?.rest === "global");
    const snapshotAtMs = Date.now();
    const input = {
      audienceSessionKey: sessionKey,
      reviewerDeviceId,
      limit: MAX_SESSION_APPROVAL_REPLAY + 1,
      nowMs: snapshotAtMs,
    };
    const readRevision = scope.revision;
    const prepared = await prepareOperatorApprovalReplay(input);
    // A replay read can be the first observer after a suspended timer. Emit
    // the durable timeout tombstone before returning the authoritative set.
    if (prepared.outcome === "expired") {
      for (const record of prepared.records) {
        const reconciled = await params.reconcileTerminal?.(record);
        if (reconciled !== true) {
          publish({ phase: "terminal", record });
        }
      }
    }
    if (params.isCurrent?.() === false) {
      throw new Error("Operator approval replay authority is no longer current");
    }
    const revision = prepared.outcome === "expired" ? scope.revision : readRevision;
    const records =
      prepared.outcome === "expired" ? await listPendingOperatorApprovals(input) : prepared.records;
    const storeIsCurrent = prepared.outcome === "pending" ? prepared.isCurrent : undefined;
    const selectedIndex = selection
      ? resolveSessionSubscriptionKey(selection.sessionKey, selection.agentId)
      : sessionKey;
    const liveGuards: Array<() => boolean> = [];
    let readsLineage = false;
    let lineageSnapshot: ReturnType<typeof getSubagentSessionListReadSnapshotIdentity>;
    const isCurrent = () =>
      revision === scope.revision &&
      storeIsCurrent?.() !== false &&
      liveGuards.every((guard) => guard()) &&
      (!readsLineage || lineageSnapshot === getSubagentSessionListReadSnapshotIdentity());
    const approvals: PendingApprovalSnapshot[] = [];
    let truncated = records.length > MAX_SESSION_APPROVAL_REPLAY;
    for (const record of records) {
      if (approvals.length === MAX_SESSION_APPROVAL_REPLAY) {
        break;
      }
      if (exactGlobal) {
        if (!record.source.sessionKey) {
          truncated = true;
          continue;
        }
        const sourceAgent =
          record.source.agentId ?? parseAgentSessionKey(record.source.sessionKey)?.agentId;
        const direct =
          sourceAgent &&
          normalizeAgentId(sourceAgent) === selection.agentId &&
          record.source.sessionKey === selection.sessionKey;
        if (!direct) {
          if (!readsLineage) {
            lineageSnapshot = getSubagentSessionListReadSnapshotIdentity();
            readsLineage = true;
          }
          let audience: string[];
          try {
            audience = await resolveApprovalSessionAudienceWithFallback(
              record.source.sessionKey,
              record.source.agentId,
              { exact: true },
            );
          } catch {
            lineageSnapshot ??= getSubagentSessionListReadSnapshotIdentity();
            truncated = true;
            continue;
          }
          const currentLineage = getSubagentSessionListReadSnapshotIdentity();
          if (lineageSnapshot !== undefined && lineageSnapshot !== currentLineage) {
            throw new Error("Approval lineage changed during replay");
          }
          lineageSnapshot = currentLineage;
          if (!audience.includes(selectedIndex)) {
            continue;
          }
        }
        const manager = params.getLiveManager?.(record.kind);
        const live = manager?.getLiveSnapshot(record.id);
        if (
          !manager ||
          !live ||
          manager.runtimeEpoch !== record.runtimeEpoch ||
          !manager.isPending(live) ||
          !matchesApprovalSource(live.request, record.source)
        ) {
          // An unresolved candidate cannot make this bounded result authoritative,
          // but must not hide other actionable approvals behind a failed subscribe.
          truncated = true;
          continue;
        }
        liveGuards.push(() => manager.isPending(live));
      }
      const approval = projectOperatorApprovalSnapshot(record, controlUiBasePath);
      if (approval?.status === "pending") {
        const sourceSessionKey = resolveApprovalSourceStreamKeyForRecord(record);
        approvals.push({
          ...approval,
          ...(sourceSessionKey ? { sourceSessionKey } : {}),
        });
      }
    }
    const replay: SessionApprovalReplay = {
      sessionKey: selection?.sessionKey ?? sessionKey,
      updatedAtMs: snapshotAtMs,
      approvals,
      truncated,
    };
    return {
      replay,
      isCurrent,
      reusable: storeIsCurrent !== undefined && (!exactGlobal || (!readsLineage && !truncated)),
    };
  };

  return {
    publish,
    replay: async (sessionKey, client, selection) => {
      if (!canReviewOperatorApproval(client)) {
        return {
          replay: {
            sessionKey,
            updatedAtMs: Date.now(),
            approvals: [],
            truncated: false,
          },
          isCurrent: () => !canReviewOperatorApproval(client),
          release: () => {},
        };
      }
      const scopes = [...(client?.connect.scopes ?? [])];
      const deviceId = client?.connect.device?.id;
      const reviewerDeviceId = scopes.includes(ADMIN_SCOPE) ? undefined : deviceId?.trim();
      const assertCurrent = () => {
        if (
          params.isCurrent?.() === false ||
          client?.invalidated ||
          !canReviewOperatorApproval(client) ||
          scopes.join("\0") !== client?.connect.scopes?.join("\0") ||
          (!scopes.includes(ADMIN_SCOPE) && deviceId !== client?.connect.device?.id)
        ) {
          throw new Error("Operator approval replay authority is no longer current");
        }
      };
      assertCurrent();
      // Completed replay is reusable only while the durable owner confirms its
      // selection and deadline, independently of runtime lifecycle publications.
      const key = JSON.stringify([sessionKey, reviewerDeviceId, selection]);
      let scope = replayScopes.get(key);
      if (!scope) {
        scope = {
          sessionKey,
          selection,
          reviewerDeviceId,
          references: 0,
          revision: 0,
        };
        replayScopes.set(key, scope);
      }
      const retained = scope;
      idleScopes.delete(key);
      retained.references += 1;
      let released = false;
      const release = () => {
        if (released) {
          return;
        }
        released = true;
        retained.references -= 1;
        if (retained.references === 0) {
          if (retained.completed?.isCurrent()) {
            idleScopes.set(key, retained);
            if (idleScopes.size > MAX_IDLE_REPLAY_SCOPES) {
              const oldest = idleScopes.keys().next().value!;
              idleScopes.delete(oldest);
              replayScopes.delete(oldest);
            }
          } else {
            replayScopes.delete(key);
          }
        }
      };
      try {
        let prepared = retained.completed;
        if (!prepared?.isCurrent()) {
          retained.completed = undefined;
          let preparation = retained.preparation;
          if (!preparation) {
            preparation = prepareReplay(retained)
              .then((snapshot) => {
                if (
                  retained.preparation === preparation &&
                  snapshot.reusable &&
                  snapshot.isCurrent()
                ) {
                  retained.completed = snapshot;
                }
                return snapshot;
              })
              .finally(() => {
                if (retained.preparation === preparation) {
                  retained.preparation = undefined;
                }
              });
            retained.preparation = preparation;
          }
          prepared = await preparation;
        }
        assertCurrent();
        return {
          replay: prepared.replay,
          isCurrent: () => {
            assertCurrent();
            return !released && prepared.isCurrent();
          },
          release,
        };
      } catch (error) {
        release();
        throw error;
      }
    },
  };
}
