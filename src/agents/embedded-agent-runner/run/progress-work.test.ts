import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import {
  upsertSessionEntryCore,
  resetSessionEntryLifecycle,
} from "../../../config/sessions/session-accessor.js";
import * as hydration from "../../../config/sessions/session-transcript-hydration.js";
import { captureSessionTranscriptTargetBinding } from "../../../config/sessions/transcript-target-binding.js";
import { progressCardStore } from "../../../gateway/progress-card-store.js";
import { getAgentRunLifecycleGeneration } from "../../../infra/agent-run-registry.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import { captureProgressWorkReader, progressWorkTurnContext } from "./progress-work.js";

it.each(["main", "second"])(
  "preserve-tail retains %s obligations without old coverage in a shared store",
  async (agentId) => {
    await withOpenClawTestState(
      { label: "retained-reset-owner", scenario: "minimal" },
      async (state) => {
        const storePath = state.path("shared-reset.sqlite");
        setRuntimeConfigSnapshot({
          agents: { entries: { main: {}, second: {} } },
          session: { store: storePath },
        });
        await upsertSessionEntryCore(
          {
            agentId: "main",
            storePath,
            sessionKey: "agent:main:physical-owner",
            sessionId: "physical",
          },
          { sessionId: "physical", updatedAt: 1 },
        );
        const target = captureSessionTranscriptTargetBinding({
          agentId,
          storePath,
          sessionKey: "agent:" + agentId + ":reset",
          sessionId: "retained-reset",
          expectedLifecycleRevision: "before",
        });
        await upsertSessionEntryCore(target, {
          sessionId: target.sessionId,
          lifecycleRevision: "before",
          updatedAt: 1,
        });
        let manager = await SessionManager.openAsync(target, state.workspaceDir);
        const appendSource = async (turnId: string) => {
          const source = {
            runId: turnId,
            turnId,
            toolCallId: turnId + "-plan",
            processGeneration: getAgentRunLifecycleGeneration(),
          };
          await manager.appendMessageAsync(
            makeAgentAssistantMessage({
              turnId,
              stopReason: "toolUse",
              content: [
                { type: "toolCall", id: source.toolCallId, name: "progress_card", arguments: {} },
              ],
            }),
          );
          await manager.appendMessageAsync({
            role: "toolResult",
            toolCallId: source.toolCallId,
            toolName: "progress_card",
            content: [{ type: "text", text: "Saved" }],
            isError: false,
            timestamp: 1,
          });
          return source;
        };
        const source = await appendSource("before-reset");
        const reader = captureProgressWorkReader({ target, assertCurrent() {} });
        const steps = [{ step: "Finish retained work", status: "pending" as const }];
        await progressCardStore.put(
          target.sessionKey,
          {
            steps,
            workCommand: {
              kind: "begin",
              owner: reader.owner,
              source,
              expected: null,
              scope: "Retained task",
            },
          },
          agentId,
        );
        expect(await reader.read()).toMatchObject({ coverage: { kind: "covered" } });
        await resetSessionEntryLifecycle({
          agentId,
          storePath,
          target: { canonicalKey: target.sessionKey, storeKeys: [target.sessionKey] },
          resetBoundary: { context: "preserve-tail", reason: "idle", cwd: state.workspaceDir },
          buildNextEntry: (entry) => ({
            ...entry,
            sessionId: target.sessionId,
            lifecycleRevision: "after",
            updatedAt: 2,
          }),
        });
        const current = captureProgressWorkReader({
          target: { ...target, expectedLifecycleRevision: "after" },
          assertCurrent() {},
        });
        const snapshot = await current.read();
        expect(snapshot).toMatchObject({
          kind: "retained",
          state: {
            generation: 1,
            revision: 2,
            record: { owner: { agentId, lifecycleRevision: "after" }, steps },
          },
        });
        expect(snapshot).toMatchObject({ coverage: { kind: "unavailable" } });
        manager = await SessionManager.openAsync(
          { ...target, expectedLifecycleRevision: "after" },
          state.workspaceDir,
        );
        const reconciledSource = await appendSource("after-reset");
        await progressCardStore.put(
          target.sessionKey,
          {
            workCommand: {
              kind: "reconcile",
              owner: current.owner,
              source: reconciledSource,
              expected: { generation: 1, revision: 2 },
              disposition: { kind: "actionable" },
            },
          },
          agentId,
        );
        expect(await current.read()).toMatchObject({
          kind: "retained",
          state: { revision: 3, record: { source: reconciledSource, steps } },
          coverage: { kind: "covered" },
        });
      },
    );
  },
);

it("keeps logical owners separate in a shared file and retains captured reads after config switching", async () => {
  await withOpenClawTestState(
    { label: "retained-shared-owner", scenario: "minimal" },
    async (state) => {
      const storePath = state.path("shared.sqlite");
      const config = {
        agents: { entries: { main: {}, second: {} } },
        session: { store: storePath },
      };
      setRuntimeConfigSnapshot(config);
      const captures: Array<ReturnType<typeof captureProgressWorkReader>> = [];
      for (const agentId of ["main", "second"]) {
        const target = captureSessionTranscriptTargetBinding({
          agentId,
          storePath,
          sessionKey: "agent:" + agentId + ":retained",
          sessionId: agentId + "-incarnation",
        });
        await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
        const reader = captureProgressWorkReader({ target, assertCurrent() {} });
        captures.push(reader);
        await progressCardStore.put(
          target.sessionKey,
          {
            steps: [{ step: agentId + " obligation", status: "pending" }],
            workCommand: {
              kind: "begin",
              owner: reader.owner,
              source: {
                runId: "run",
                turnId: "turn",
                toolCallId: "save",
                processGeneration: getAgentRunLifecycleGeneration(),
              },
              expected: null,
              scope: agentId + " scope",
            },
          },
          agentId,
        );
      }
      // A current config revision does not by itself revoke the original physical read owner.
      setRuntimeConfigSnapshot({ ...config, session: { store: state.path("replacement.sqlite") } });
      for (const [index, reader] of captures.entries()) {
        const agentId = index === 0 ? "main" : "second";
        expect(await reader.read()).toMatchObject({
          kind: "retained",
          state: {
            record: {
              owner: { agentId },
              scope: agentId + " scope",
              steps: [{ step: agentId + " obligation" }],
            },
          },
        });
      }
    },
  );
});

it("never turns nested, pruned or failed execution observation into covered work", async () => {
  await withOpenClawTestState(
    { label: "retained-coverage", scenario: "minimal" },
    async (state) => {
      const storePath = state.path("coverage.sqlite");
      setRuntimeConfigSnapshot({
        agents: { entries: { main: {} } },
        session: { store: storePath },
      });
      for (const mode of ["covered", "compacted", "nested", "pruned", "fault"] as const) {
        const target = captureSessionTranscriptTargetBinding({
          agentId: "main",
          storePath,
          sessionKey: "agent:main:" + mode,
          sessionId: "coverage-" + mode,
        });
        await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
        const manager = await SessionManager.openAsync(target, state.workspaceDir);
        const source = {
          runId: "saved-run",
          turnId: "saved-turn",
          toolCallId: "saved-plan",
          processGeneration: getAgentRunLifecycleGeneration(),
        };
        await manager.appendMessageAsync(
          makeAgentAssistantMessage({
            turnId: source.turnId,
            stopReason: "toolUse",
            content: [
              {
                type: "toolCall",
                id: source.toolCallId,
                name: "progress_card",
                arguments: { plan: [{ step: "Finish", status: "pending" }] },
              },
            ],
          }),
        );
        await manager.appendMessageAsync({
          role: "toolResult",
          toolCallId: source.toolCallId,
          toolName: "progress_card",
          content: [{ type: "text", text: "Saved" }],
          isError: false,
          timestamp: 1,
        });
        const reader = captureProgressWorkReader({ target, assertCurrent() {} });
        await progressCardStore.put(
          target.sessionKey,
          {
            steps: [{ step: "Finish", status: "pending" }],
            workCommand: {
              kind: "begin",
              owner: reader.owner,
              source,
              expected: null,
              scope: "Finish task",
            },
          },
          "main",
        );
        if (mode === "nested")
          await manager.appendMessageAsync({
            role: "custom",
            customType: "openclaw.nested-tool-activity",
            content: "Nested effect",
            display: false,
            timestamp: 2,
          });
        if (mode === "compacted") {
          const kept = await manager.appendMessageAsync({
            role: "user",
            content: "Continue",
            timestamp: 3,
          });
          if (!kept) throw new Error("Missing retained entry");
          await manager.appendCompactionAsync("Earlier work", kept, 100);
          await manager.reloadPersistedTranscriptAsync();
        }
        if (mode === "pruned")
          await manager.appendMessageAsync({
            role: "user",
            content: "x".repeat(300_000),
            timestamp: 4,
          });
        const prepare = hydration.prepareSessionTranscriptHydration;
        const fault =
          mode === "fault"
            ? vi
                .spyOn(hydration, "prepareSessionTranscriptHydration")
                .mockImplementation((...args) => ({
                  ...prepare(...args),
                  read: async () => {
                    throw new Error("Read observer unavailable");
                  },
                }))
            : undefined;
        try {
          const snapshot = await reader.read();
          expect(snapshot).toMatchObject({
            kind: "retained",
            state: {
              revision: 1,
              record: {
                disposition: { kind: "actionable" },
                steps: [{ step: "Finish", status: "pending" }],
              },
            },
          });
          expect(snapshot, mode).toMatchObject({
            coverage:
              mode === "covered" || mode === "compacted"
                ? { kind: "covered", basis: "bounded-no-handoff" }
                : { kind: "unavailable" },
          });
          if (mode !== "covered" && mode !== "compacted") {
            expect(progressWorkTurnContext(snapshot)).toContain(
              "Unavailable observation never authorizes resubmission",
            );
            expect(progressWorkTurnContext(snapshot), mode).toContain('"kind":"unavailable"');
          }
        } finally {
          fault?.mockRestore();
        }
      }
    },
  );
});
