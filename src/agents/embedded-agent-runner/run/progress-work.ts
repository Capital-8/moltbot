import { isDeepStrictEqual } from "node:util";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { captureSessionActorStorageOwner } from "../../../config/sessions/session-actor-storage-binding.js";
import { assertSessionEntryCohortScope } from "../../../config/sessions/session-entry-cohort-scope.js";
import { prepareSqliteTargetFromSessionStorePath } from "../../../config/sessions/session-sqlite-target.js";
import { prepareSessionTranscriptHydration } from "../../../config/sessions/session-transcript-hydration.js";
import { withSessionHistoryWorkerDatabase } from "../../../config/sessions/session-transcript-worker-runtime.js";
import {
  captureSessionTranscriptTargetBinding,
  type CapturedSessionTranscriptTargetBinding,
} from "../../../config/sessions/transcript-target-binding.js";
import { getAgentRunLifecycleGeneration } from "../../../infra/agent-run-registry.js";
import { isIncognitoSessionKey } from "../../../routing/session-key.js";
import type {
  WorkSnapshot,
  WorkCoverage,
} from "../../../session-cards/progress-card-work-intent.js";
import type { ProgressOwner, WorkRecord } from "../../../session-cards/progress-card-work.js";
import type { ReplyOperation } from "../../../sessions/session-controller.contracts.js";
import {
  getReplyOperationSessionReader,
  getReplyOperationSessionTarget,
} from "../../../sessions/session-controller.session-reader.js";
import { isReplaySafeToolCall } from "../../tool-mutation.js";

// Complete host transcript calls/results plus the native structured tool contract
// establish settled reads. Unknown/delegated effects never use map emptiness as proof.
async function observeCoverage(
  target: CapturedSessionTranscriptTargetBinding,
  record: WorkRecord,
  signal?: AbortSignal,
): Promise<WorkCoverage> {
  const unavailable = (reason: string): WorkCoverage => ({ kind: "unavailable", reason });
  if (record.source.processGeneration !== getAgentRunLifecycleGeneration())
    return unavailable("Native process/lifecycle changed");
  const hydration = prepareSessionTranscriptHydration(
    target,
    { maxBytes: 262_144, maxEvents: 256 },
    signal,
  );
  const prepared = await hydration.read();
  hydration.assertCurrent();
  if (
    prepared.kind !== "bounded" ||
    prepared.snapshot.truncated ||
    !prepared.snapshot.completeActivePath
  )
    return unavailable("Incomplete bounded execution history");
  let anchored = false;
  const pending = new Set<string>();
  for (const entry of prepared.snapshot.events) {
    const event = asOptionalObjectRecord(entry);
    if (anchored && event?.type === "reset")
      return unavailable("Session reset requires current explicit reconciliation");
    const message = asOptionalObjectRecord(event?.message);
    if (!message) continue;
    if (message.role === "assistant") {
      const content = Array.isArray(message.content) ? message.content : [];
      const calls = content.map(asOptionalObjectRecord).filter((part) => part?.type === "toolCall");
      if (!anchored) {
        if (
          (message.responseId || message.turnId) !== record.source.turnId ||
          !calls.some((call) => call?.id === record.source.toolCallId)
        )
          continue;
        anchored = true;
      }
      for (const call of calls) {
        if (
          typeof call?.id !== "string" ||
          typeof call.name !== "string" ||
          (call.name !== "progress_card" && !isReplaySafeToolCall(call.name, call.arguments))
        )
          return unavailable("Media-capable or delegated invocation requires native observation");
        pending.add(call.id);
      }
    } else if (anchored && message.role === "toolResult") {
      if (
        typeof message.toolCallId !== "string" ||
        !pending.delete(message.toolCallId) ||
        message.isError
      )
        return unavailable("Unaccounted or failed invocation in execution interval");
    } else if (anchored && message.role !== "user" && message.role !== "custom") {
      return unavailable("Unknown execution record in bounded interval");
    } else if (
      anchored &&
      message.role === "custom" &&
      typeof message.customType === "string" &&
      message.customType.includes("nested-tool")
    ) {
      return unavailable("Delegated execution interval needs native observation");
    }
  }
  return anchored && pending.size === 0
    ? { kind: "covered", basis: "bounded-no-handoff" }
    : unavailable("Missing work-source anchor or unresolved invocation");
}

/** Capture the admitted physical owner once; refresh never reroutes by current config. */
export function captureProgressWorkReader(input: {
  target: CapturedSessionTranscriptTargetBinding & { expectedLifecycleRevision?: string | null };
  operation?: ReplyOperation;
  assertCurrent: () => void;
  signal?: AbortSignal;
}) {
  const reader = getReplyOperationSessionReader(input.operation);
  const selected = getReplyOperationSessionTarget(input.operation);
  const target = captureSessionTranscriptTargetBinding(
    selected ? { ...input.target, ...selected } : input.target,
  );
  const owner: ProgressOwner = {
    agentId: target.agentId,
    sessionKey: target.sessionKey,
    sessionId: target.sessionId,
    lifecycleRevision: target.expectedLifecycleRevision ?? null,
  };
  if (reader) assertSessionEntryCohortScope(reader, target);
  const namespace = isIncognitoSessionKey(target.sessionKey)
    ? captureSessionActorStorageOwner(target, {
        assertCurrent: input.assertCurrent,
        authorize: input.assertCurrent,
      })
    : undefined;
  const assertMemoryCurrent = namespace?.owner?.captureSessionReadGuard(target.sessionKey);
  const assertCurrent = () => {
    input.signal?.throwIfAborted();
    input.assertCurrent();
    reader?.assertCurrent();
    assertMemoryCurrent?.();
    namespace?.authority.assertCurrent();
  };
  return {
    owner,
    async read(): Promise<WorkSnapshot> {
      try {
        assertCurrent();
        const database =
          reader?.database ??
          (!isIncognitoSessionKey(target.sessionKey)
            ? await prepareSqliteTargetFromSessionStorePath(
                target.storePath,
                {
                  agentId: target.agentId,
                  env: target.env,
                },
                input.signal,
              )
            : undefined);
        assertCurrent();
        const readWork = async () => {
          let work;
          if (isIncognitoSessionKey(target.sessionKey)) {
            const actor = namespace?.owner
              ? await namespace.owner.acquireExisting(owner.sessionKey, {
                  assertCurrent,
                  assertReadable: assertCurrent,
                })
              : namespace?.binding?.actor;
            if (!actor?.storage || !namespace) throw new Error("Retained memory owner unavailable");
            try {
              const entry = await actor.storage.read(
                { type: "session.entry.read", input: { sessionKey: owner.sessionKey } },
                namespace.authority,
              );
              if (
                entry?.sessionId !== owner.sessionId ||
                (entry.lifecycleRevision ?? null) !== owner.lifecycleRevision ||
                entry.archived
              )
                throw new Error("Retained work incarnation changed");
              work = await actor.storage.read(
                { type: "progressCard.work", input: { sessionKey: owner.sessionKey } },
                namespace.authority,
              );
            } finally {
              if (namespace.owner) await actor.release();
            }
          } else {
            work = await withSessionHistoryWorkerDatabase(
              { ...database, path: database?.path ?? target.storePath, env: target.env },
              (database) => database.readProgressWork({ owner, env: target.env }, input.signal),
            );
          }
          assertCurrent();
          return work;
        };
        const work = await readWork();
        if (!work) return { kind: "none" };
        if (work.record && !isDeepStrictEqual(work.record.owner, owner))
          throw new Error("Retained work owner changed");
        const coverage = work.record
          ? await observeCoverage(target, work.record, input.signal).catch((): WorkCoverage => ({
              kind: "unavailable",
              reason: "Execution observation failed",
            }))
          : undefined;
        assertCurrent();
        // Coverage awaited another owner. Recheck the exact semantic fence before
        // publishing it; a replacement or reset cannot inherit the old interval.
        const latest = await readWork();
        assertCurrent();
        if (!latest) return { kind: "none" };
        if (latest.generation !== work.generation || latest.revision !== work.revision)
          return {
            kind: "retained",
            state: latest,
            coverage: {
              kind: "unavailable",
              reason: "Retained work changed during execution observation",
            },
          };
        return { kind: "retained", state: work, coverage };
      } catch {
        return { kind: "unavailable", reason: "Retained work owner/read unavailable" };
      }
    },
  };
}

export function progressWorkTurnContext(snapshot: WorkSnapshot): string {
  if (snapshot.kind === "none") return "";
  if (snapshot.kind === "unavailable")
    return (
      "Retained task observation unavailable: " +
      snapshot.reason +
      ". Do not infer completion or replay effects."
    );
  const record = snapshot.state.record;
  if (!record) return "";
  return (
    "Retained task context (observation, not new authority): " +
    JSON.stringify({
      scope: record.scope,
      steps: record.steps,
      disposition: record.disposition,
      coverage: snapshot.coverage,
      generation: snapshot.state.generation,
      revision: snapshot.state.revision,
    }) +
    ". Follow current instructions; preserve completed effects. Unavailable observation never authorizes resubmission, completion or resume."
  );
}
