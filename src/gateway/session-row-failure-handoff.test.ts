import { expect, it } from "vitest";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { publishSubagentRunChanges } from "../agents/subagents/registry/subagent-registry-publication.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createSessionRowDeltaDiffer,
  prepareSessionRowDeltaFields,
} from "./session-row-delta-fields.js";
import { prepareSessionRowPublication } from "./session-row-presentation.js";
import {
  createTestProjection,
  seedRow,
} from "./session-row-projection.read-fixture.test-support.js";

it.each(["spawner", "ancestor"])(
  "projects committed exact-run failure custody for the %s, retaining diagnostics and invalidating its reset",
  async (recipient) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const parent = "agent:main:handoff-parent";
      const child = "agent:main:subagent:handoff-child";
      const consumer = recipient === "ancestor" ? "agent:main:ancestor" : parent;
      const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
      seedRow(parent, { sessionId: "spawner", lifecycleRevision: "spawner-1", updatedAt: 1 });
      seedRow(consumer, { sessionId: "parent", lifecycleRevision: "parent-1", updatedAt: 1 });
      const childEntry = {
        sessionId: "child",
        updatedAt: 2,
        spawnedBy: parent,
        lastRunId: "failure-run",
        status: "failed" as const,
        lastRunError: "Synthetic cause",
      };
      seedRow(child, childEntry);
      const run = createSubagentRunRecord({
        runId: "failure-run",
        childSessionKey: child,
        requesterSessionKey: parent,
        endedAt: 2,
        outcome: { status: "error", error: "Synthetic cause" },
      });
      subagentRuns.set(run.runId, run);
      try {
        using projection = await createTestProjection({ cfg: {}, modelCatalog: [] });
        const read = async (rowMode: "sidebar" | "dashboard" = "sidebar") => {
          await projection.ensureMaterialized();
          return prepareSessionRowPublication(projection, Date.now())()
            .getPresentation()
            .snapshot({ agentId: "main", key: child }, { rowMode }).row!;
        };
        for (const status of ["pending", "in_progress", "delivered"] as const) {
          subagentRuns.set(run.runId, { ...run, delivery: { status } });
          publishSubagentRunChanges([child, parent], [run.runId]);
          expect(await read()).not.toHaveProperty("failureHandedOff");
        }
        subagentRuns.set(run.runId, {
          ...run,
          delivery: {
            status: "in_progress",
            failureHandoff: {
              requesterSessionKey: consumer,
              requesterSessionId: "parent",
              requesterLifecycleRevision: "parent-1",
              requesterStorePath: storePath,
            },
          },
        });
        publishSubagentRunChanges([child, parent], [run.runId]);
        expect(await read()).toMatchObject({
          failureHandedOff: true,
          status: "failed",
          lastRunError: "Synthetic cause",
        });
        const handedOff = await read();
        expect(handedOff.failureHandedOff).toBe(true);
        expect((await read("dashboard")).failureHandedOff).toBe(true);
        expect(JSON.stringify(await read())).not.toContain("requesterSessionKey");
        seedRow(consumer, { sessionId: "parent", lifecycleRevision: "parent-reset", updatedAt: 3 });
        const reset = await read();
        expect(reset).not.toHaveProperty("failureHandedOff");
        const differ = createSessionRowDeltaDiffer();
        expect(
          differ(
            prepareSessionRowDeltaFields(handedOff),
            prepareSessionRowDeltaFields(reset),
            reset,
          ),
        ).toMatchObject({ remove: ["failureHandedOff"] });
        seedRow(consumer, { sessionId: "parent", lifecycleRevision: "parent-1", updatedAt: 4 });
        const restored = await read();
        expect(restored.failureHandedOff).toBe(true);
        await patchSessionEntryCore({ agentId: "main", sessionKey: child, storePath }, () => ({
          lastRunId: "new-own-error",
          updatedAt: 4,
        }));
        const nextRun = await read();
        expect(nextRun).not.toHaveProperty("failureHandedOff");
        expect(
          differ(
            prepareSessionRowDeltaFields(restored),
            prepareSessionRowDeltaFields(nextRun),
            nextRun,
          ),
        ).toMatchObject({ remove: ["failureHandedOff"] });
        expect(nextRun).toMatchObject({
          status: "failed",
          lastRunError: "Synthetic cause",
        });
      } finally {
        subagentRuns.delete(run.runId);
      }
    });
  },
);
