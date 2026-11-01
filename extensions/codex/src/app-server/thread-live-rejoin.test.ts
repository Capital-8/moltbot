import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { ensureCodexAppServerClientRuntime } from "./client-runtime.js";
import {
  fingerprintCodexDynamicToolHandoffAdmission,
  buildCodexDynamicToolHandoffAdmissionConfig,
  type CodexDynamicToolHandoff,
} from "./dynamic-tool-handoff.js";
import { createCodexTestHostCapabilities } from "./host-capability.test-support.js";
import type { CodexAppServerThreadBinding } from "./session-binding.js";
import { createCodexTestBindingStore } from "./session-binding.test-helpers.js";
import { createCodexThreadLifecycleTimingTracker } from "./thread-lifecycle-timing.js";
import type {
  CodexStartOrResumeThreadParams,
  CodexThreadRequestContext,
} from "./thread-lifecycle-types.js";
import {
  createAppServerOptions,
  createParams,
  createCodexLifecycleHarness,
  resetThreadLifecycleTestFixtures,
} from "./thread-lifecycle.test-fixtures.js";
import {
  assertCodexLiveRejoinCandidate,
  canAttemptCodexLiveRejoin,
  prepareCodexLiveRejoin,
} from "./thread-live-rejoin.js";

afterEach(resetThreadLifecycleTestFixtures);

async function fixture(status = "inProgress", items: Record<string, unknown>[] = []) {
  const params = createParams("/tmp/live-rejoin-session.jsonl", "/tmp/live-rejoin-workspace");
  const assertCurrent = vi.fn();
  params.hostCapabilities = createCodexTestHostCapabilities({
    registerToolHandoffSettlement: vi.fn(),
    restartRecoveryClaim: {
      sourceRunId: "old-host-run",
      recoveryRunId: params.runId,
      assertCurrent,
    },
  });
  const wire = createCodexLifecycleHarness({
    respond(method) {
      if (method === "thread/turns/list") {
        return {
          data: [{ id: "accepted-turn", status, itemsView: "full", items }],
          nextCursor: null,
        };
      }
      throw new Error(`unexpected request ${method}`);
    },
  });
  ensureCodexAppServerClientRuntime(wire.client, { agentDir: "/tmp/live-rejoin-agent" });
  onTestFinished(async () => {
    await wire.client.closeAndWait();
  });
  wire.seed(
    { thread: { id: "thread-1", status: { type: "active" }, turns: [] } },
    { loaded: true, subscribed: false },
  );
  const bindingStore = Object.assign(createCodexTestBindingStore(), {
    managedThreads: {
      has: vi.fn(async () => true),
      mark: vi.fn(async () => true),
      snapshot: vi.fn(async () => new Map()),
    },
  });
  const binding: CodexAppServerThreadBinding = {
    threadId: "thread-1",
    clientId: "old-host-client",
    cwd: params.workspaceDir!,
    model: params.modelId,
    modelProvider: "openai",
    dynamicToolsFingerprint: "tools",
    dynamicToolsContainDeferred: false,
    turnRecovery: { turnId: "accepted-turn", state: "accepted" },
  };
  const appServer = createAppServerOptions();
  appServer.start = { ...appServer.start, transport: "websocket", url: "ws://127.0.0.1:1234" };
  const handoff: CodexDynamicToolHandoff = {
    version: 1,
    coverage: "all-dynamic-tools",
    sourceRunId: "old-host-run",
    turnId: "accepted-turn",
    admissionFingerprint: fingerprintCodexDynamicToolHandoffAdmission(
      binding,
      buildCodexDynamicToolHandoffAdmissionConfig(appServer),
    ),
    calls: [
      {
        callId: "effect",
        requestId: 7,
        requestFingerprint: "a".repeat(64),
        state: "completed",
        response: { success: true, contentItems: [{ type: "inputText", text: "done" }] },
      },
    ],
  };
  binding.dynamicToolHandoff = handoff;
  const bindingIdentity = { kind: "conversation" as const, bindingId: "rejoin-owned-conversation" };
  await bindingStore.mutate(bindingIdentity, { kind: "set", binding });
  const input: CodexStartOrResumeThreadParams = {
    client: wire.client,
    params,
    cwd: binding.cwd!,
    bindingStore,
    dynamicTools: [],
    isDynamicToolHandoffAuthorized: () => true,
    appServer,
  };
  const context: CodexThreadRequestContext = {
    bindingIdentity,
    startModelSelection: { model: params.modelId, modelProvider: "openai" },
    startModelProvider: "openai",
    dynamicToolsFingerprint: "tools",
    dynamicToolsContainDeferred: false,
    hostSystemAgentActive: false,
    ringZeroActive: false,
    restrictedToolSurface: false,
    restrictedToolSurfaceInheritedMcpServerNames: [],
    lifecycleTiming: createCodexThreadLifecycleTimingTracker(),
    normalizeBindingModelProvider: (_, provider) => provider,
    throwIfAborted() {},
  };
  return { input, binding, handoff, context, assertCurrent, wire };
}

describe("authenticated live Codex handoff admission", () => {
  it("claims the same active turn without sending resume, start, interrupt or a prompt", async () => {
    const f = await fixture();
    const result = await prepareCodexLiveRejoin(f.input, f.binding, f.context);
    try {
      expect(result.threadId).toBe("thread-1");
      expect(result.lifecycle.rejoinedTurn).toEqual({
        turnId: "accepted-turn",
        sourceRunId: "old-host-run",
      });
      expect(f.input.bindingStore.read(f.context.bindingIdentity)?.clientId).toBe(
        f.wire.client.getInstanceId(),
      );
      expect(f.wire.request.mock.calls.map(([method]) => method)).toEqual([
        "thread/read",
        "thread/turns/list",
      ]);
      expect(f.assertCurrent).toHaveBeenCalled();
    } finally {
      result.liveThreadOwnership?.forget();
    }
  });

  it.each(["interrupted", "completed"])(
    "refuses cold or already terminal %s turns before admission",
    async (status) => {
      const f = await fixture(status);
      await expect(prepareCodexLiveRejoin(f.input, f.binding, f.context)).rejects.toThrow(
        "complete, current handoff",
      );
      expect(f.input.bindingStore.read(f.context.bindingIdentity)?.clientId).toBe(
        "old-host-client",
      );
    },
  );

  it.each([
    { status: "inProgress", item: { type: "userMessage" }, admitted: true },
    { status: "inProgress", item: { type: "commandExecution" }, admitted: false },
    {
      status: "completed",
      item: { type: "agentMessage", text: "Original answer" },
      admitted: true,
    },
    {
      status: "completed",
      item: { type: "agentMessage", text: "No final", phase: "commentary" },
      admitted: false,
    },
    {
      status: "completed",
      item: { type: "agentMessage", text: "Already sent", delivery: "async" },
      admitted: false,
    },
  ])(
    "requires affirmative original-turn evidence for $status $item.type $admitted",
    async ({ status, item, admitted }) => {
      const f = await fixture(status, [item]);
      f.handoff.calls = [];
      const result = prepareCodexLiveRejoin(f.input, f.binding, f.context);
      if (admitted) {
        const binding = await result;
        expect(binding.lifecycle.rejoinedTurn?.turnId).toBe("accepted-turn");
        expect(Boolean(binding.lifecycle.rejoinedTurn?.terminalOnly)).toBe(status === "completed");
        binding.liveThreadOwnership?.forget();
      } else {
        await expect(result).rejects.toThrow("complete, current handoff");
      }
      expect(f.wire.request.mock.calls.map(([method]) => method)).toEqual([
        "thread/read",
        "thread/turns/list",
      ]);
    },
  );

  it.each([false, true])(
    "never re-authorizes a pending approval, including with a completed receipt (%s)",
    async (withReceipt) => {
      const f = await fixture("inProgress", [{ type: "userMessage" }]);
      if (!withReceipt) {
        f.handoff.calls = [];
      }
      f.wire.seed(
        {
          thread: {
            id: "thread-1",
            status: { type: "active", activeFlags: ["waitingOnApproval"] },
            turns: [],
          },
        },
        { loaded: true, subscribed: false },
      );
      await expect(prepareCodexLiveRejoin(f.input, f.binding, f.context)).rejects.toThrow(
        "complete, current handoff",
      );
      expect(f.wire.request.mock.calls.map(([method]) => method)).toEqual([
        "thread/read",
        "thread/turns/list",
      ]);
    },
  );

  it.each([
    { parent: "thread-1", status: "active", admit: true },
    { parent: "thread-1", status: "idle", admit: true },
    { parent: "another-parent", status: "active", admit: false },
    { parent: "thread-1", status: "systemError", admit: false },
  ])(
    "rejoins only the parent of a known child ($parent, $status)",
    async ({ parent, status, admit }) => {
      const f = await fixture("inProgress", [
        { type: "userMessage" },
        { type: "subAgentActivity", kind: "started", agentThreadId: "child" },
      ]);
      f.handoff.calls = [];
      f.wire.seed(
        {
          thread: {
            id: "child",
            parentThreadId: parent,
            threadSource: "subagent",
            status: { type: status },
            turns: [],
          },
        },
        { loaded: true, subscribed: false },
      );
      const result = prepareCodexLiveRejoin(f.input, f.binding, f.context);
      if (admit) {
        const resumed = await result;
        expect(resumed.threadId).toBe("thread-1");
        resumed.liveThreadOwnership?.forget();
      } else {
        await expect(result).rejects.toThrow("complete, current handoff");
      }
      expect(f.wire.request.mock.calls.map(([method]) => method)).toEqual([
        "thread/read",
        "thread/turns/list",
        "thread/read",
      ]);
    },
  );

  it.each(["missing", "unknown-result", "unsupported", "wrong-source"])(
    "refuses %s handoffs",
    async (failure) => {
      const f = await fixture();
      if (failure === "missing") {
        f.binding.dynamicToolHandoff = undefined;
      }
      if (failure === "unknown-result") {
        const call = f.handoff.calls[0]!;
        f.handoff.calls = [
          {
            callId: call.callId,
            requestId: call.requestId,
            requestFingerprint: call.requestFingerprint,
            state: "started",
          },
        ];
      }
      if (failure === "unsupported") {
        f.handoff.unsupported = true;
      }
      if (failure === "wrong-source") {
        f.handoff.sourceRunId = "other-task";
      }
      if (failure === "wrong-source") {
        expect(() => canAttemptCodexLiveRejoin(f.input, f.binding)).toThrow();
      } else {
        expect(canAttemptCodexLiveRejoin(f.input, f.binding)).toBe(false);
      }
      expect(() => assertCodexLiveRejoinCandidate(f.input, f.binding)).toThrow(
        "complete, current handoff",
      );
      expect(f.wire.request).not.toHaveBeenCalled();
    },
  );

  it("does not authorize restart from prompt provenance and rejects revoked custody", async () => {
    const f = await fixture();
    f.input.params.hostCapabilities = createCodexTestHostCapabilities();
    f.input.params.inputProvenance = {
      kind: "internal_system",
      sourceTool: "main_session_restart_recovery",
    };
    expect(canAttemptCodexLiveRejoin(f.input, f.binding)).toBe(false);
    expect(() => assertCodexLiveRejoinCandidate(f.input, f.binding)).toThrow();
    f.input.params.hostCapabilities = createCodexTestHostCapabilities({
      registerToolHandoffSettlement: vi.fn(),
      restartRecoveryClaim: {
        sourceRunId: "old-host-run",
        recoveryRunId: f.input.params.runId,
        assertCurrent() {
          throw new Error("revoked custody");
        },
      },
    });
    await expect(prepareCodexLiveRejoin(f.input, f.binding, f.context)).rejects.toThrow(
      "revoked custody",
    );
  });

  it("rejects narrower current sandbox policy before releasing native callbacks", async () => {
    const f = await fixture();
    f.input.appServer.sandbox = "read-only";
    await expect(prepareCodexLiveRejoin(f.input, f.binding, f.context)).rejects.toThrow(
      "complete, current handoff",
    );
    expect(f.wire.request).not.toHaveBeenCalled();
    expect(f.input.bindingStore.read(f.context.bindingIdentity)?.clientId).toBe("old-host-client");
  });

  it("requires the original hook generation and canonical command when re-registering", async () => {
    const f = await fixture();
    f.binding.nativeHookRelayGeneration = "old-hook-generation";
    const oldConfig = {
      "hooks.PermissionRequest": [
        { hooks: [{ type: "command", command: "old-command --generation old-hook-generation" }] },
      ],
    };
    f.handoff.admissionFingerprint = fingerprintCodexDynamicToolHandoffAdmission(
      f.binding,
      buildCodexDynamicToolHandoffAdmissionConfig(f.input.appServer, oldConfig),
    );
    f.input.buildFinalConfigPatch = vi.fn(async () => ({
      nativeHookRelayGeneration: "old-hook-generation",
      configPatch: { "hooks.PermissionRequest": [] },
    }));
    await expect(prepareCodexLiveRejoin(f.input, f.binding, f.context)).rejects.toThrow(
      "complete, current handoff",
    );
    expect(f.wire.request).not.toHaveBeenCalled();
  });

  it("rejects tightened current exec authority before contacting the surviving native turn", async () => {
    const f = await fixture();
    f.input.isDynamicToolHandoffAuthorized = () => false;
    await expect(prepareCodexLiveRejoin(f.input, f.binding, f.context)).rejects.toThrow(
      "complete, current handoff",
    );
    expect(f.wire.request).not.toHaveBeenCalled();
  });

  it("refuses a changed effective environment even when the saved receipt is intact", async () => {
    const f = await fixture();
    f.context.environmentSelectionFingerprint = "changed-environment";
    await expect(prepareCodexLiveRejoin(f.input, f.binding, f.context)).rejects.toThrow(
      "complete, current handoff",
    );
    expect(f.wire.request).not.toHaveBeenCalled();
  });
});
