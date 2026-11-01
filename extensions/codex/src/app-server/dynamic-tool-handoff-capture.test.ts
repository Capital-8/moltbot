import { describe, expect, it, vi } from "vitest";
import {
  beginCodexDynamicToolHandoff,
  recordCodexDynamicToolHandoffResult,
  recordCodexDynamicToolHandoffStarted,
} from "./dynamic-tool-handoff-capture.js";
import {
  buildCodexDynamicToolHandoffAdmissionConfig,
  fingerprintCodexDynamicToolHandoffAdmission,
  isCodexDynamicToolHandoffComplete,
  readCodexDynamicToolHandoffV1,
} from "./dynamic-tool-handoff.js";
import type { CodexDynamicToolRuntimeResponse } from "./dynamic-tool-response-state.js";
import type { CodexAttemptResources } from "./run-attempt-resources.js";
import { createCodexTestBindingStore } from "./session-binding.test-helpers.js";

async function fixture() {
  const bindingStore = createCodexTestBindingStore();
  const bindingIdentity = { kind: "conversation" as const, bindingId: "capture-owner" };
  const runtimeThread = {
    threadId: "thread",
    clientId: "client",
    cwd: "/repo",
    modelProvider: "openai",
    lifecycle: { action: "started" as const },
    turnRecovery: { turnId: "turn", state: "accepted" as const },
  };
  // Real start persists a fuller policy than it returns, and native attribution can differ.
  await bindingStore.mutate(bindingIdentity, {
    kind: "set",
    binding: {
      ...runtimeThread,
      modelProvider: undefined,
      webSearchThreadConfigFingerprint: '{"web_search":"cached"}',
      nativeToolPolicyRestricted: true,
    },
  });
  const drain = new AbortController();
  const opened = Promise.withResolvers<void>();
  const registerToolHandoffSettlement = vi.fn(() => opened.resolve());
  const connection = {
    bindingStore,
    bindingIdentity,
    params: {
      runId: "source",
      sessionKey: "agent:main:main",
      hostCapabilities: {
        assertActive: () => {},
        registerToolHandoffSettlement,
        toolHandoffDrainSignal: drain.signal,
      },
    },
    appServer: {
      start: { transport: "websocket" },
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      codeModeOnly: true,
    },
  };
  const resources = {
    prompt: { context: { runtime: { connection } } },
    state: { thread: runtimeThread, nativeHookRelayConfigPatch: { hooks: "original" } },
  } as unknown as CodexAttemptResources;
  const readHandoff = () =>
    readCodexDynamicToolHandoffV1(bindingStore.read(bindingIdentity)?.dynamicToolHandoff);
  return {
    resources,
    bindingStore,
    bindingIdentity,
    registerToolHandoffSettlement,
    drain,
    opened: opened.promise,
    readHandoff,
  };
}

function request(id: number) {
  return {
    requestId: id,
    call: {
      threadId: "thread",
      turnId: "turn",
      callId: `call-${id}`,
      tool: "gateway_exec",
      arguments: { command: "echo ok" },
    },
  };
}

const assertCurrent = () => {};
const exactText: CodexDynamicToolRuntimeResponse = {
  success: true,
  contentItems: [{ type: "inputText", text: "original output" }],
  handoffDisposition: "eligible",
};

describe("Codex tool handoff during Gateway drain", () => {
  it("opens a single snapshot of in-flight original requests under the accepted binding policy", async () => {
    const f = await fixture();
    const writes = vi.spyOn(f.bindingStore, "mutate");
    const config = buildCodexDynamicToolHandoffAdmissionConfig(
      f.resources.prompt.context.runtime.connection.appServer,
      f.resources.state.nativeHookRelayConfigPatch,
    );
    const stored = f.bindingStore.read(f.bindingIdentity)!;
    const fingerprint = fingerprintCodexDynamicToolHandoffAdmission(stored, config);
    expect(fingerprint).not.toBe(
      fingerprintCodexDynamicToolHandoffAdmission(f.resources.state.thread, config),
    );

    await beginCodexDynamicToolHandoff(f.resources, "turn", assertCurrent);
    await recordCodexDynamicToolHandoffStarted(f.resources, request(1), assertCurrent);
    await recordCodexDynamicToolHandoffStarted(f.resources, request(2), assertCurrent);
    expect(writes).not.toHaveBeenCalled();
    f.drain.abort();
    await f.opened;

    expect(writes).toHaveBeenCalledOnce();
    const snapshot = f.readHandoff();
    expect(snapshot?.admissionFingerprint).toBe(fingerprint);
    expect(snapshot?.calls.map(({ requestId, state }) => [requestId, state])).toEqual([
      [1, "started"],
      [2, "started"],
    ]);
    await recordCodexDynamicToolHandoffResult(f.resources, request(1), exactText, assertCurrent);
    expect(f.readHandoff()?.calls[0]).toMatchObject({
      state: "completed",
      response: { success: true, contentItems: exactText.contentItems },
    });
    expect(isCodexDynamicToolHandoffComplete(f.readHandoff()!)).toBe(false);
    await recordCodexDynamicToolHandoffResult(
      f.resources,
      request(2),
      { ...exactText, handoffDisposition: "unsupported" },
      assertCurrent,
    );
    expect(f.readHandoff()?.calls[1]?.state).toBe("unsupported");
    expect(isCodexDynamicToolHandoffComplete(f.readHandoff()!)).toBe(false);
    expect(f.registerToolHandoffSettlement).toHaveBeenCalledOnce();
  });

  it("keeps an ordinary turn with a finished pre-drain call out of recovery", async () => {
    const f = await fixture();
    const writes = vi.spyOn(f.bindingStore, "mutate");
    await beginCodexDynamicToolHandoff(f.resources, "turn", assertCurrent);
    await recordCodexDynamicToolHandoffStarted(f.resources, request(1), assertCurrent);
    await recordCodexDynamicToolHandoffResult(f.resources, request(1), exactText, assertCurrent);
    expect(writes).not.toHaveBeenCalled();
    f.drain.abort();
    await recordCodexDynamicToolHandoffStarted(f.resources, request(2), assertCurrent);
    await recordCodexDynamicToolHandoffResult(f.resources, request(2), exactText, assertCurrent);
    expect(writes).not.toHaveBeenCalled();
    expect(f.readHandoff()).toBeUndefined();
    expect(f.registerToolHandoffSettlement).not.toHaveBeenCalled();
  });

  it("leaves an ordinary admitted turn running if the opening snapshot cannot be written", async () => {
    const f = await fixture();
    const writes = vi.spyOn(f.bindingStore, "mutate").mockResolvedValueOnce(false);
    await beginCodexDynamicToolHandoff(f.resources, "turn", assertCurrent);
    f.drain.abort();
    await recordCodexDynamicToolHandoffStarted(f.resources, request(1), assertCurrent);
    await recordCodexDynamicToolHandoffResult(f.resources, request(1), exactText, assertCurrent);
    expect(writes).toHaveBeenCalledOnce();
    expect(f.readHandoff()).toBeUndefined();
    expect(f.registerToolHandoffSettlement).not.toHaveBeenCalled();
  });

  it("requires current accepted ownership and a durable pre-dispatch write after capture opens", async () => {
    const f = await fixture();
    await beginCodexDynamicToolHandoff(f.resources, "turn", assertCurrent);
    f.drain.abort();
    await f.opened;
    vi.spyOn(f.bindingStore, "mutate").mockResolvedValueOnce(false);
    await expect(
      recordCodexDynamicToolHandoffStarted(f.resources, request(1), assertCurrent),
    ).rejects.toThrow("recording dynamic tool handoff");
    expect(f.readHandoff()?.calls).toEqual([]);
    await f.bindingStore.mutate(f.bindingIdentity, {
      kind: "patch",
      threadId: "thread",
      clientId: "client",
      patch: { turnRecovery: { turnId: "successor", state: "accepted" } },
    });
    await expect(
      recordCodexDynamicToolHandoffStarted(f.resources, request(2), assertCurrent),
    ).rejects.toThrow();
    expect(f.readHandoff()?.calls).toEqual([]);
  });
});
