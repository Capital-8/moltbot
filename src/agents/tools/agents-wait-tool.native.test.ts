import { describe, expect, it, onTestFinished, vi } from "vitest";
import { copyInternalToolResultState } from "../../../packages/agent-core/src/internal-hooks.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { makeTextToolResult } from "../../../test/helpers/text-tool-result.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  upsertSessionEntryCore,
  loadTranscriptEvents,
} from "../../config/sessions/session-accessor.js";
import { createAgentTurnTestContext } from "../../gateway/agent-turn/agent-run-dispatch.test-support.js";
import {
  prepareAgentRunUserTurn,
  releasePreparedAgentRunUserTurn,
} from "../../gateway/agent-turn/agent-run-user-turn.js";
import type { NativeSubagentRuntime } from "../../plugins/runtime/types-native-subagent.js";
import { attachSessionTranscriptRunId } from "../../sessions/transcript-events.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { installSessionToolResultGuard } from "../session-tool-result-guard.js";
import { SessionManager } from "../sessions/session-manager.js";
import { loadRequesterSessionEntry } from "../subagents/announce/subagent-announce-delivery.runtime.js";
import { prepareChildCompletionFindings } from "../subagents/announce/subagent-announce-result.js";
import { createRequesterSettleReceiptAdmission } from "../subagents/announce/subagent-announce.requester-settle-receipt.js";
import { subagentRuns } from "../subagents/registry/subagent-registry-memory.js";
import { mutateSubagentRuns } from "../subagents/registry/subagent-registry-persistence.js";
import { subscribeSubagentRunChanges } from "../subagents/registry/subagent-registry-publication.js";
import {
  loadSubagentRegistryFromSqlite,
  persistRegistryFixture,
} from "../subagents/registry/subagent-registry-state.fixture.test-support.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import {
  createAgentsWaitTool,
  readNativeSubagentCollection,
  withNativeSubagentCollectorOwner,
} from "./agents-wait-tool.js";
import { collectorRun } from "./agents-wait-tool.test-support.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";

const key = "agent:main:main";
const owner = {
  currentSessionKeys: new Set([key]),
  currentAgentId: "main",
  expectedRequester: { sessionId: "parent", lifecycleRevision: "revision-2" },
};
const withRegistry = (run: () => Promise<void>) =>
  withOpenClawTestState({ env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } }, run);

async function collectResult({
  signal,
  assertCurrent = () => {},
  ...params
}: Parameters<NativeSubagentRuntime["collect"]>[0] & {
  signal?: AbortSignal;
  assertCurrent?: () => void;
}) {
  const tool = createAgentsWaitTool({ agentSessionKey: key, agentId: "main" });
  const result = await withNativeSubagentCollectorOwner(
    tool,
    "native-collector-test",
    { ...owner, assertCurrent },
    () => tool.execute("native-collector-test", params, signal),
  );
  return result;
}

async function collect(params: Parameters<typeof collectResult>[0]) {
  return readNativeSubagentCollection((await collectResult(params)).details);
}

function committedHandoff(ids: string[]) {
  const committed = createDeferred();
  const unsubscribe = subscribeSubagentRunChanges("persistence", () => {
    if (ids.every((id) => subagentRuns.get(id)?.delivery?.failureHandoff)) {
      committed.resolve();
    }
  });
  onTestFinished(unsubscribe);
  return committed.promise;
}

function record(
  id: string,
): import("../subagents/registry/subagent-registry.types.js").SubagentRunRecord {
  return {
    ...collectorRun(id, key),
    delivery: { status: "not_required" as const },
    completionRequesterSessionId: "parent",
    completionRequesterLifecycleRevision: "revision-2",
  };
}

describe("native collector requester ownership", () => {
  it("reads persisted pending and completed results, refusing other parents and reset incarnations", async () => {
    await withRegistry(async () => {
      const done = {
        ...record("done"),
        collectorCompletion: { status: "done" as const },
        completion: { required: false, resultText: "reviewed" },
      };
      const reset = { ...record("reset"), completionRequesterLifecycleRevision: "revision-1" };
      const foreign = { ...record("foreign"), swarmRequesterSessionKey: "agent:main:other" };
      persistRegistryFixture(
        new Map([done, record("pending"), reset, foreign].map((entry) => [entry.runId, entry])),
      );
      const result = await collect({
        ids: ["done", "pending", "reset", "foreign", "missing"],
        timeoutSeconds: 0,
      });
      expect(result.completed).toMatchObject([
        { runId: "done", result: "reviewed", status: "done" },
      ]);
      expect(result.pending).toEqual(["pending"]);
      expect(result.errors).toEqual([
        { runId: "reset", error: "not_owner" },
        { runId: "foreign", error: "not_owner" },
        { runId: "missing", error: "not_found" },
      ]);
    });
  });

  it.each(["error", "timeout"] as const)(
    "returns a persisted %s cause and retained progress",
    async (status) => {
      await withRegistry(async () => {
        const failed = {
          ...record("failed"),
          execution: {
            status: "terminal" as const,
            endedAt: 8,
            outcome: { status, error: "synthetic provider unavailable" },
          },
          collectorCompletion: {
            status: status === "timeout" ? ("timeout" as const) : ("failed" as const),
          },
          completion: { required: false, resultText: "Saved investigation progress" },
        };
        persistRegistryFixture(new Map([[failed.runId, failed]]));
        const result = await collect({ ids: [failed.runId], timeoutSeconds: 0 });
        expect(result.completed).toMatchObject([
          {
            runId: "failed",
            status: status === "timeout" ? "timeout" : "failed",
            error: "synthetic provider unavailable",
            result: "Saved investigation progress\n\nSaved partial progress unavailable.",
          },
        ]);
        expect(result.completed[0]?.resultTruncated).toBeUndefined();
        expect(result.pending).toEqual([]);
        expect(result.errors).toBeUndefined();
      });
    },
  );

  it.each(["error", "timeout"] as const)(
    "bounds the complete %s result including genuine multibyte partial progress",
    async (status) => {
      await withOpenClawTestState(
        { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
        async (state) => {
          setRuntimeConfigSnapshot({ agents: { entries: { main: {}, worker: {} } } });
          const storePath = resolveSessionStorePathCore(undefined, { agentId: "worker" });
          const failed = record("large-progress");
          const target = {
            agentId: "worker",
            sessionKey: failed.childSessionKey,
            sessionId: "large-child",
            storePath,
          };
          await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
          const manager = await SessionManager.openAsync(target, state.sessionsDir("worker"));
          await manager.appendMessageAsync({ role: "user", content: "Investigate", timestamp: 1 });
          await manager.appendMessageAsync(
            attachSessionTranscriptRunId(
              makeAgentAssistantMessage({
                content: [
                  {
                    type: "text",
                    text: "Measured progress: " + "界".repeat(40_000) + "END-OF-PROGRESS",
                  },
                ],
              }),
              failed.runId,
            ),
          );
          failed.execution = {
            status: "terminal",
            endedAt: 8,
            outcome: { status, error: "Required failure cause" },
            transcriptTarget: target,
          };
          failed.collectorCompletion = { status: status === "timeout" ? "timeout" : "failed" };
          failed.completion = { required: false, resultText: "Required failure cause" };
          persistRegistryFixture(new Map([[failed.runId, failed]]));
          const result = (await collect({ ids: [failed.runId], timeoutSeconds: 0 })).completed[0]!;
          expect(result).toMatchObject({
            status: status === "timeout" ? "timeout" : "failed",
            error: "Required failure cause",
            resultTruncated: true,
          });
          expect(result.result).toContain("Required failure cause");
          expect(result.result).toContain(
            "Saved partial progress (not a completed result):\nMeasured progress: 界",
          );
          expect(Buffer.byteLength(result.result, "utf8")).toBeLessThanOrEqual(100 * 1024);
          expect(result.result).toContain("[truncated: frozen completion output exceeded 100KB");
          expect(result.result).not.toContain("END-OF-PROGRESS");
          expect(result.result).not.toContain("�");
        },
      );
    },
  );

  it.each([1, 2])(
    "assigns %s-source ancestor collection to its actual durable consumer, not the failed spawners",
    async (count) => {
      await withOpenClawTestState(
        { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
        async (state) => {
          const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
          setRuntimeConfigSnapshot({ session: { store: storePath } });
          const target = { agentId: "main", sessionKey: key, sessionId: "ancestor", storePath };
          await upsertSessionEntryCore(target, {
            sessionId: "ancestor",
            lifecycleRevision: "ancestor-1",
            updatedAt: 1,
          });
          const entries = await Promise.all(
            ["failed-g", "failed-other-g"].slice(0, count).map(async (prefix) => {
              const id = prefix + "-" + count;
              const spawner = "agent:main:subagent:" + id;
              await upsertSessionEntryCore(
                { ...target, sessionKey: spawner },
                { sessionId: id, lifecycleRevision: "spawner-1", status: "failed", updatedAt: 1 },
              );
              const source = await loadRequesterSessionEntry(spawner, "main");
              return Object.assign(collectorRun(id + "-child", spawner), {
                requesterStorePath: source.physicalStorePath,
                completionRequesterSessionId: id,
                completionRequesterLifecycleRevision: "spawner-1",
                swarmWaitOwnerSessionKeys: [spawner, key],
                delivery: { status: "not_required" as const },
                execution: {
                  status: "terminal" as const,
                  endedAt: 8,
                  outcome: { status: "error" as const, error: id + " failed" },
                },
                collectorCompletion: { status: "failed" as const },
                completion: { required: false, resultText: id + " saved work" },
              });
            }),
          );
          persistRegistryFixture(new Map(entries.map((entry) => [entry.runId, entry])));
          const tool = createAgentsWaitTool({ agentSessionKey: key, agentId: "main" });
          const result = await withGatewayToolCallerIdentity(
            { agentId: "main", sessionKey: key },
            () =>
              withNativeSubagentCollectorOwner(
                tool,
                "ancestor-collect",
                { currentSessionKeys: new Set([key]), currentAgentId: "main", assertCurrent() {} },
                () =>
                  tool.execute("ancestor-collect", {
                    ids: entries.map((entry) => entry.runId),
                    timeoutSeconds: 0,
                  }),
              ),
          );
          expect(readNativeSubagentCollection(result.details).completed).toHaveLength(count);
          expect(
            entries.every(
              (entry) =>
                !loadSubagentRegistryFromSqlite().get(entry.runId)?.delivery?.failureHandoff,
            ),
          ).toBe(true);
          const manager = await SessionManager.openAsync(target, state.sessionsDir());
          await manager.appendMessageAsync({
            role: "user",
            content: "Recover descendant work",
            timestamp: 1,
          });
          installSessionToolResultGuard(manager);
          await manager.appendMessageAsync(
            makeAgentAssistantMessage({
              content: [
                {
                  type: "toolCall",
                  id: "ancestor-collect",
                  name: "agents_wait",
                  arguments: { ids: entries.map((entry) => entry.runId) },
                },
              ],
            }),
          );
          const committed = committedHandoff(entries.map((entry) => entry.runId));
          await manager.appendMessageAsync(
            copyInternalToolResultState(
              result,
              makeTextToolResult(
                "ancestor-collect",
                "agents_wait",
                JSON.stringify(result.details),
                false,
                2,
              ),
            ),
          );
          await committed;
          {
            for (const entry of entries) {
              const saved = loadSubagentRegistryFromSqlite().get(entry.runId)!;
              expect(saved.delivery?.failureHandoff).toMatchObject({
                requesterSessionKey: key,
                requesterSessionId: "ancestor",
                requesterLifecycleRevision: "ancestor-1",
              });
              expect(saved.requesterSessionKey).toBe(entry.requesterSessionKey);
              expect(saved.completionRequesterSessionId).toBe(entry.completionRequesterSessionId);
              expect(saved.swarmWaitOwnerSessionKeys).toEqual(entry.swarmWaitOwnerSessionKeys);
              expect(saved.delivery?.status).toBe("not_required");
            }
          }
          expect(JSON.stringify(await loadTranscriptEvents(target))).toContain(
            "failed-g-" + count + " failed",
          );
        },
      );
    },
  );

  it.each(["reset", "revoke", "policy", "abort", "source", "ownership", "foreign"] as const)(
    "does not certify ancestor custody after %s",
    async (change) => {
      await withOpenClawTestState(
        { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
        async (state) => {
          const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
          setRuntimeConfigSnapshot({ session: { store: storePath } });
          const target = { agentId: "main", sessionKey: key, sessionId: "ancestor", storePath };
          await upsertSessionEntryCore(target, {
            sessionId: "ancestor",
            lifecycleRevision: "ancestor-1",
            updatedAt: 1,
          });
          const failed = {
            ...collectorRun("revoked-child-" + change, "agent:main:subagent:failed-spawner"),
            delivery: { status: "not_required" as const },
            swarmWaitOwnerSessionKeys: [
              "agent:main:subagent:failed-spawner",
              ...(change === "foreign" ? [] : [key]),
            ],
            execution: {
              status: "terminal" as const,
              endedAt: 8,
              outcome: { status: "error" as const, error: "Revocation cause" },
            },
            collectorCompletion: { status: "failed" as const },
            completion: { required: false, resultText: "Saved work" },
          };
          persistRegistryFixture(new Map([[failed.runId, failed]]));
          let active = true;
          let allowed = true;
          const controller = new AbortController();
          const tool = createAgentsWaitTool({ agentSessionKey: key, agentId: "main" });
          const result = await withGatewayToolCallerIdentity(
            {
              agentId: "main",
              sessionKey: key,
              assertToolAllowed: () => {
                if (!allowed) {
                  throw new Error("policy revoked");
                }
              },
            },
            () =>
              withNativeSubagentCollectorOwner(
                tool,
                "collect-negative",
                {
                  currentSessionKeys: new Set([key]),
                  currentAgentId: "main",
                  assertCurrent() {
                    if (!active) {
                      throw new Error("consumer revoked");
                    }
                  },
                },
                () =>
                  tool.execute(
                    "collect-negative",
                    { ids: [failed.runId], timeoutSeconds: 0 },
                    controller.signal,
                  ),
              ),
          );
          const collected = readNativeSubagentCollection(result.details);
          if (change === "foreign") {
            expect(collected.completed).toEqual([]);
            expect(collected.errors).toEqual([{ runId: failed.runId, error: "not_owner" }]);
          } else {
            expect(collected.completed).toHaveLength(1);
          }
          if (change === "reset") {
            await upsertSessionEntryCore(target, {
              sessionId: "ancestor",
              lifecycleRevision: "ancestor-2",
              updatedAt: 2,
            });
          }
          if (change === "revoke") {
            active = false;
          }
          if (change === "policy") {
            allowed = false;
          }
          if (change === "abort") {
            controller.abort();
          }
          if (change === "source" || change === "ownership") {
            await mutateSubagentRuns(
              [failed.runId],
              (rows) => {
                const source = rows.get(failed.runId)!;
                const replacement =
                  change === "source"
                    ? { ...source, generation: 2 }
                    : { ...source, swarmWaitOwnerSessionKeys: [source.requesterSessionKey] };
                return { value: undefined, postimages: new Map([[failed.runId, replacement]]) };
              },
              { preparedRows: () => new Map([[failed.runId, failed]]) },
            );
          }
          const manager = await SessionManager.openAsync(target, state.sessionsDir());
          await manager.appendMessageAsync({
            role: "user",
            content: "Inspect saved failure",
            timestamp: 1,
          });
          installSessionToolResultGuard(manager);
          await manager.appendMessageAsync(
            makeAgentAssistantMessage({
              content: [
                {
                  type: "toolCall",
                  id: "collect-negative",
                  name: "agents_wait",
                  arguments: { ids: [failed.runId] },
                },
              ],
            }),
          );
          const warning = vi
            .spyOn((await import("../../runtime.js")).defaultRuntime, "log")
            .mockImplementation(() => {});
          try {
            await manager.appendMessageAsync(
              copyInternalToolResultState(
                result,
                makeTextToolResult(
                  "collect-negative",
                  "agents_wait",
                  JSON.stringify(result.details),
                  false,
                  2,
                ),
              ),
            );
            if (change !== "foreign") {
              await vi.waitFor(() => {
                expect(
                  loadSubagentRegistryFromSqlite().get(failed.runId)?.delivery?.failureHandoff,
                ).toBeUndefined();
                expect(warning).toHaveBeenCalledWith(
                  expect.stringContaining("Collector failure handoff could not be recorded"),
                );
              });
            }
            expect(
              loadSubagentRegistryFromSqlite().get(failed.runId)?.delivery?.failureHandoff,
            ).toBeUndefined();
          } finally {
            warning.mockRestore();
          }
        },
      );
    },
  );

  it.each([
    [false, false],
    [true, false],
    [true, true],
  ])(
    "leaves omitted failures recoverable until consumed (visible failure=%s, rejected=%s)",
    async (visibleFailure, rejected) => {
      await withOpenClawTestState(
        { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
        async (state) => {
          const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
          setRuntimeConfigSnapshot({ session: { store: storePath } });
          const target = { agentId: "main", sessionKey: key, sessionId: "parent", storePath };
          const entry = { sessionId: "parent", lifecycleRevision: "revision-2", updatedAt: 1 };
          await upsertSessionEntryCore(target, entry);
          const requester = await loadRequesterSessionEntry(key, "main");
          const failed = (id: string, createdAt: number) => ({
            ...record(id),
            createdAt,
            requesterStorePath: requester.physicalStorePath,
            execution: {
              status: "terminal" as const,
              endedAt: 8,
              outcome: { status: "error" as const, error: id + " cause" },
            },
            collectorCompletion: { status: "failed" as const },
            completion: { required: false, resultText: id + " saved progress" },
          });
          const tail = failed("omitted-tail", 1_000);
          const visible = failed("visible-failure", 0);
          const failures = visibleFailure ? [visible, tail] : [tail];
          for (const child of failures) {
            subagentRuns.set(child.runId, child);
          }
          persistRegistryFixture(new Map(failures.map((child) => [child.runId, child])));
          // Only the failed sources need native rows. This bounded pure inventory
          // fills the production prefix without opening hundreds of child runtimes.
          const healthy = Array.from({ length: 600 }, (_, index) => ({
            ...record("healthy-" + index),
            childSessionKey: "agent:main:subagent:healthy-" + index,
            task: "Healthy " + index,
            createdAt: index + 1,
            execution: {
              status: "terminal" as const,
              endedAt: 8,
              outcome: { status: "ok" as const },
            },
            announceResult: "HEALTHY_RUNTIME_ONLY".repeat(30),
          }));
          const batch = prepareChildCompletionFindings([...healthy, ...failures]);
          expect(batch.events.some((event) => event.childSessionKey === tail.childSessionKey)).toBe(
            false,
          );
          expect(batch.events[0]?.replyInstruction).toContain("additional child results omitted");
          expect(batch.events[0]?.replyInstruction).toContain("Inspect remaining children");
          const admission = createRequesterSettleReceiptAdmission({
            requester,
            identity: entry,
            storeSessionKey: key,
            storeAgentId: "main",
            storePaths: () => [requester.physicalStorePath],
            isSourceCurrent: () => true,
            readCurrent: () => entry,
            isStoreCurrent: () => true,
          });
          const onInputCommitted = vi.fn(
            admission.observeFailureHandoff(batch.representedChildren, () => true),
          );
          const message = "Continue the OpenClaw runtime event.";
          const turn = await prepareAgentRunUserTurn({
            cfg: { session: { store: storePath } },
            resolvedSessionKey: key,
            admittedSessionId: "parent",
            activeSessionAgentId: "main",
            sessionEntry: entry,
            assertCurrent: () => {},
            onUserTurnMediaPersisted: () => {},
            suppressVisibleSessionEffects: false,
            requestedPromptPersistenceSuppression: false,
            canUseInternalRuntimeHandoff: false,
            message,
            effectiveTranscriptInputText: message,
            images: [],
            offloadedRefs: [],
            runId: "announce:overflow",
            client: null,
            context: createAgentTurnTestContext(),
            onInputCommitted,
            inputProvenance: {
              kind: "inter_session",
              sourceTool: "subagent_settle",
              sourceSessionKey: tail.childSessionKey,
            },
            request: {
              message,
              idempotencyKey: "announce:overflow",
              deliver: false,
              expectedExistingSessionId: "parent",
              internalEvents: batch.events,
            },
          });
          try {
            expect(turn.recorder).toBeDefined();
            const write = turn.recorder!.persistApproved(
              rejected
                ? {
                    target: async () => {
                      throw new Error("Input refused");
                    },
                  }
                : undefined,
            );
            if (rejected) {
              await expect(write).rejects.toThrow("Input refused");
              expect(onInputCommitted).not.toHaveBeenCalled();
              expect(await loadTranscriptEvents(target)).toEqual([]);
            } else {
              expect(await write).toMatchObject({ appended: true });
              expect(onInputCommitted).toHaveBeenCalledOnce();
              await onInputCommitted.mock.results[0]?.value;
            }
            const saved = loadSubagentRegistryFromSqlite();
            expect(saved.get(tail.runId)?.delivery?.failureHandoff).toBeUndefined();
            expect(Boolean(saved.get(visible.runId)?.delivery?.failureHandoff)).toBe(
              visibleFailure && !rejected,
            );
            const transcript = JSON.stringify(await loadTranscriptEvents(target));
            expect(transcript).not.toContain("HEALTHY_RUNTIME_ONLY");
            expect(transcript).not.toContain("omitted-tail saved progress");
            if (visibleFailure && !rejected) {
              expect(transcript).toContain("visible-failure cause");
              expect(transcript).toContain("visible-failure saved progress");
            }
          } finally {
            await releasePreparedAgentRunUserTurn(turn);
          }
          if (rejected) {
            return;
          }
          // Reading the omitted result is not custody; the actual collector's
          // acknowledged tool-result append is the later recovery boundary.
          const result = await collectResult({ ids: [tail.runId], timeoutSeconds: 0 });
          expect(readNativeSubagentCollection(result.details).completed).toMatchObject([
            {
              runId: tail.runId,
              error: "omitted-tail cause",
              result: expect.stringContaining("omitted-tail saved progress"),
            },
          ]);
          expect(
            loadSubagentRegistryFromSqlite().get(tail.runId)?.delivery?.failureHandoff,
          ).toBeUndefined();
          const manager = await SessionManager.openAsync(target, state.sessionsDir());
          installSessionToolResultGuard(manager);
          await manager.appendMessageAsync(
            makeAgentAssistantMessage({
              content: [
                {
                  type: "toolCall",
                  id: "recover-tail",
                  name: "agents_wait",
                  arguments: { ids: [tail.runId] },
                },
              ],
            }),
          );
          const committed = committedHandoff([tail.runId]);
          await manager.appendMessageAsync(
            copyInternalToolResultState(
              result,
              makeTextToolResult(
                "recover-tail",
                "agents_wait",
                JSON.stringify(result.details),
                false,
                2,
              ),
            ),
          );
          await committed;
          expect(
            loadSubagentRegistryFromSqlite().get(tail.runId)?.delivery?.failureHandoff,
          ).toMatchObject({ requesterSessionId: "parent" });
          expect(JSON.stringify(await loadTranscriptEvents(target))).toContain(
            "omitted-tail saved progress",
          );
          expect(JSON.stringify(await loadTranscriptEvents(target))).not.toContain(
            "HEALTHY_RUNTIME_ONLY",
          );
        },
      );
    },
  );

  it("records failed collector custody only after the real tool result is durably appended", async () => {
    await withOpenClawTestState(
      { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
      async (state) => {
        const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
        setRuntimeConfigSnapshot({
          session: { store: storePath },
        });
        const target = { agentId: "main", sessionKey: key, sessionId: "parent", storePath };
        await upsertSessionEntryCore(target, {
          sessionId: "parent",
          lifecycleRevision: "revision-2",
          updatedAt: 1,
        });
        const requester = await loadRequesterSessionEntry(key, "main");
        const failed = {
          ...record("durable-failure"),
          requesterStorePath: requester.physicalStorePath,
          execution: {
            status: "terminal" as const,
            endedAt: 8,
            outcome: { status: "error" as const, error: "synthetic failure" },
          },
          collectorCompletion: { status: "failed" as const },
          completion: { required: false, resultText: "Saved findings" },
        };
        persistRegistryFixture(new Map([[failed.runId, failed]]));
        expect((await loadRequesterSessionEntry(key, "main")).entry).toMatchObject({
          sessionId: "parent",
          lifecycleRevision: "revision-2",
        });
        const result = await collectResult({ ids: [failed.runId], timeoutSeconds: 0 });
        expect(
          loadSubagentRegistryFromSqlite().get(failed.runId)?.delivery?.failureHandoff,
        ).toBeUndefined();
        const manager = await SessionManager.openAsync(target, state.sessionsDir());
        await manager.appendMessageAsync({ role: "user", content: "Review child", timestamp: 1 });
        installSessionToolResultGuard(manager);
        await manager.appendMessageAsync(
          makeAgentAssistantMessage({
            content: [
              {
                type: "toolCall",
                id: "collect",
                name: "agents_wait",
                arguments: { ids: [failed.runId] },
              },
            ],
          }),
        );
        await manager.appendMessageAsync(
          copyInternalToolResultState(
            result,
            makeTextToolResult("collect", "agents_wait", JSON.stringify(result.details), false, 2),
          ),
        );
        await vi.waitFor(() =>
          expect(
            loadSubagentRegistryFromSqlite().get(failed.runId)?.delivery?.failureHandoff,
          ).toMatchObject({
            requesterSessionId: "parent",
            requesterLifecycleRevision: "revision-2",
          }),
        );
        expect(JSON.stringify(await loadTranscriptEvents(target))).toContain("synthetic failure");
        expect(loadSubagentRegistryFromSqlite().get(failed.runId)?.delivery?.status).toBe(
          "not_required",
        );
      },
    );
  });

  it.each(["abort", "revoke"] as const)(
    "refuses %s during asynchronous result preparation",
    async (failure) => {
      await withRegistry(async () => {
        persistRegistryFixture(new Map([["pending", record("pending")]]));
        const controller = new AbortController();
        const entered = createDeferred();
        let active = true;
        const result = collect({
          ids: ["pending"],
          awaitResults: true,
          signal: controller.signal,
          assertCurrent() {
            entered.resolve();
            if (!active) {
              throw new Error("request retired");
            }
          },
        });
        await entered.promise;
        if (failure === "revoke") {
          active = false;
        } else {
          controller.abort();
        }
        await expect(result).rejects.toThrow(failure === "revoke" ? "request retired" : "aborted");
      });
    },
  );
});
