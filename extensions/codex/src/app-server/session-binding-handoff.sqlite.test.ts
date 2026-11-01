import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { expect, it } from "vitest";
import {
  fingerprintCodexDynamicToolHandoffAdmission,
  readCodexDynamicToolHandoffV1,
  readCompletedCodexDynamicToolHandoffResponse,
} from "./dynamic-tool-handoff.js";
import { createCodexAppServerBindingStore } from "./session-binding.js";
import { createCodexSqliteTestBindingStateStore } from "./session-binding.sqlite.test-helpers.js";

it("persists started before effects and exact completion across binding-owner SQLite reopen", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-tool-handoff-"));
  const options = {
    namespace: "tool-handoff",
    maxEntries: 4,
    overflowPolicy: "reject-new" as const,
    env: { ...process.env, OPENCLAW_STATE_DIR: root },
  };
  const identity = { kind: "conversation" as const, bindingId: "owned" };
  const binding = {
    threadId: "thread",
    clientId: "client",
    cwd: "/repo",
    turnRecovery: { turnId: "turn", state: "accepted" as const },
  };
  const owner = {
    kind: "dynamic-tool-handoff" as const,
    threadId: "thread",
    clientId: "client",
    turnId: "turn",
    sourceRunId: "source",
  };
  const request = {
    requestId: "original-request",
    call: {
      threadId: "thread",
      turnId: "turn",
      callId: "call",
      tool: "write",
      arguments: { value: "sensitive-not-persisted" },
    },
  };
  const reopen = async () => {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    const store = createCodexAppServerBindingStore(createCodexSqliteTestBindingStateStore(options));
    await store.withLease(identity, async () => {});
    return store;
  };
  try {
    let store = await reopen();
    await store.mutate(identity, { kind: "set", binding });
    expect(
      await store.mutate(
        identity,
        {
          ...owner,
          operation: {
            kind: "begin",
            admissionFingerprint: fingerprintCodexDynamicToolHandoffAdmission(binding),
          },
        },
        () => {},
      ),
    ).toBe(true);
    expect(
      await store.mutate(identity, { ...owner, operation: { kind: "started", request } }, () => {}),
    ).toBe(true);
    store = await reopen();
    expect(
      readCodexDynamicToolHandoffV1(store.read(identity)?.dynamicToolHandoff)?.calls[0]?.state,
    ).toBe("started");
    const response = {
      success: true,
      contentItems: [{ type: "inputText" as const, text: " \nexact\t " }] as [
        { type: "inputText"; text: string },
      ],
    };
    expect(
      await store.mutate(
        identity,
        { ...owner, operation: { kind: "completed", request, response } },
        () => {},
      ),
    ).toBe(true);
    store = await reopen();
    const record = readCodexDynamicToolHandoffV1(store.read(identity)?.dynamicToolHandoff)!;
    expect(readCompletedCodexDynamicToolHandoffResponse(record, request)).toEqual(response);
    expect(JSON.stringify(record)).not.toContain("sensitive-not-persisted");
    await store.mutate(identity, {
      kind: "patch",
      threadId: "thread",
      clientId: "client",
      patch: { clientId: "new-client" },
    });
    expect(await store.mutate(identity, { ...owner, operation: { kind: "clear" } }, () => {})).toBe(
      false,
    );
    expect(readCodexDynamicToolHandoffV1(store.read(identity)?.dynamicToolHandoff)).toEqual(record);
    const currentOwner = { ...owner, clientId: "new-client" };
    // Host custody alone cannot clear an accepted native turn.
    expect(
      await store.mutate(identity, { ...currentOwner, operation: { kind: "clear" } }, () => {}),
    ).toBe(false);
    await store.mutate(identity, {
      kind: "patch",
      threadId: "thread",
      clientId: "new-client",
      patch: { turnRecovery: undefined },
    });
    expect(
      await store.mutate(identity, { ...currentOwner, operation: { kind: "clear" } }, () => {}),
    ).toBe(true);
    store = await reopen();
    expect(store.read(identity)).toEqual({
      threadId: "thread",
      clientId: "new-client",
      cwd: "/repo",
    });
    expect(Object.hasOwn(store.read(identity)!, "dynamicToolHandoff")).toBe(false);
    // Settlement must release the bounded slot for the next ordinary turn.
    await store.mutate(identity, {
      kind: "patch",
      threadId: "thread",
      clientId: "new-client",
      patch: { turnRecovery: { turnId: "next-turn", state: "accepted" } },
    });
    const nextBinding = store.read(identity)!;
    expect(
      await store.mutate(
        identity,
        {
          ...currentOwner,
          turnId: "next-turn",
          sourceRunId: "next-source",
          operation: {
            kind: "begin",
            admissionFingerprint: fingerprintCodexDynamicToolHandoffAdmission(nextBinding),
          },
        },
        () => {},
      ),
    ).toBe(true);
    store = await reopen();
    expect(readCodexDynamicToolHandoffV1(store.read(identity)?.dynamicToolHandoff)?.turnId).toBe(
      "next-turn",
    );
  } finally {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
