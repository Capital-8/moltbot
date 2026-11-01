import { describe, expect, it } from "vitest";
import {
  CODEX_DYNAMIC_TOOL_HANDOFF_MAX_BYTES,
  buildCodexDynamicToolHandoffAdmissionConfig,
  isCodexDynamicToolHandoffComplete,
  codexDynamicToolHandoffRequestIdentity,
  fingerprintCodexDynamicToolHandoffAdmission,
  readCodexDynamicToolHandoffV1,
  readCompletedCodexDynamicToolHandoffResponse,
} from "./dynamic-tool-handoff.js";
import {
  mutateCodexDynamicToolHandoffBinding,
  type CodexDynamicToolHandoffMutation,
} from "./session-binding-handoff-mutations.js";
import {
  readCodexAppServerThreadBinding,
  type StoredCodexAppServerBinding,
} from "./session-binding.js";

const identity = {
  kind: "session" as const,
  agentId: "main",
  sessionId: "session-1",
  sessionKey: "agent:main:test",
};
const request = {
  requestId: 7,
  call: {
    threadId: "thread-1",
    turnId: "turn-1",
    callId: "call-1",
    tool: "synthetic_write",
    arguments: { value: "secret-not-persisted" },
  },
};
function fixture() {
  let current: StoredCodexAppServerBinding = {
    version: 1,
    state: "active",
    sessionId: "session-1",
    binding: {
      threadId: "thread-1",
      clientId: "client-1",
      cwd: "/repo",
      turnRecovery: { turnId: "turn-1", state: "accepted" },
    },
  };
  const mutation = (
    operation: CodexDynamicToolHandoffMutation["operation"],
    patch: Partial<CodexDynamicToolHandoffMutation> = {},
  ) => ({
    kind: "dynamic-tool-handoff" as const,
    threadId: "thread-1",
    clientId: "client-1",
    turnId: "turn-1",
    sourceRunId: "source-1",
    operation,
    ...patch,
  });
  const apply = (
    operation: CodexDynamicToolHandoffMutation["operation"],
    patch?: Partial<CodexDynamicToolHandoffMutation>,
  ) => {
    const result = mutateCodexDynamicToolHandoffBinding({
      identity,
      current,
      mutation: mutation(operation, patch),
      assertCurrent: () => {},
    });
    if (result.next) {
      current = result.next;
    }
    return result.result;
  };
  const begin = () => {
    if (current.state !== "active") {
      throw new Error("inactive fixture");
    }
    return apply({
      kind: "begin",
      admissionFingerprint: fingerprintCodexDynamicToolHandoffAdmission(current.binding),
    });
  };
  const record = () => {
    if (current.state !== "active") {
      throw new Error("inactive fixture");
    }
    return readCodexDynamicToolHandoffV1(current.binding.dynamicToolHandoff)!;
  };
  return {
    apply,
    begin,
    record,
    mutation,
    get: () => current,
    set: (next: StoredCodexAppServerBinding) => {
      current = next;
    },
  };
}

describe("Codex dynamic tool handoff owner", () => {
  it.each(["", " \n unchanged \t"])(
    "keeps byte-exact completed response %j and rejects request collisions",
    (text) => {
      const f = fixture();
      expect(f.begin()).toBe(true);
      expect(f.apply({ kind: "started", request })).toBe(true);
      expect(readCompletedCodexDynamicToolHandoffResponse(f.record(), request)).toBeUndefined();
      const response = {
        success: false,
        contentItems: [{ type: "inputText" as const, text }] as [
          { type: "inputText"; text: string },
        ],
      };
      expect(f.apply({ kind: "completed", request, response })).toBe(true);
      expect(readCompletedCodexDynamicToolHandoffResponse(f.record(), request)).toEqual(response);
      expect(JSON.stringify(f.record())).not.toContain("secret-not-persisted");
      for (const changed of [
        { ...request, requestId: 8 },
        { ...request, call: { ...request.call, arguments: { value: "changed" } } },
        { ...request, call: { ...request.call, namespace: "other" } },
        { ...request, call: { ...request.call, turnId: "turn-2" } },
      ]) {
        expect(readCompletedCodexDynamicToolHandoffResponse(f.record(), changed)).toBeUndefined();
      }
      expect(f.apply({ kind: "started", request })).toBe(false);
    },
  );

  it("rejects late completion after client, turn, source, generation or authority changes", () => {
    const f = fixture();
    f.begin();
    f.apply({ kind: "started", request });
    const response = {
      success: true,
      contentItems: [{ type: "inputText" as const, text: "done" }] as [
        { type: "inputText"; text: string },
      ],
    };
    for (const patch of [
      { clientId: "new-client" },
      { turnId: "new-turn" },
      { sourceRunId: "new-source" },
    ]) {
      expect(f.apply({ kind: "completed", request, response }, patch)).toBe(false);
    }
    const current = f.get();
    expect(
      mutateCodexDynamicToolHandoffBinding({
        identity: { ...identity, sessionId: "replacement-generation" },
        current,
        mutation: f.mutation({ kind: "completed", request, response }),
        assertCurrent: () => {},
      }).result,
    ).toBe(false);
    expect(() =>
      mutateCodexDynamicToolHandoffBinding({
        identity,
        current,
        mutation: f.mutation({ kind: "completed", request, response }),
        assertCurrent: () => {
          throw new Error("revoked");
        },
      }),
    ).toThrow("revoked");
    expect(f.record().calls[0]?.state).toBe("started");
  });

  it("keeps overflow and unsupported calls ineligible without truncating or removing evidence", () => {
    const f = fixture();
    f.begin();
    f.apply({ kind: "started", request });
    expect(
      f.apply({
        kind: "completed",
        request,
        response: {
          success: true,
          contentItems: [
            { type: "inputText", text: "x".repeat(CODEX_DYNAMIC_TOOL_HANDOFF_MAX_BYTES) },
          ],
        },
      }),
    ).toBe(true);
    expect(f.record().unsupported).toBe(true);
    expect(f.record().calls[0]?.state).toBe("started");
    expect(readCompletedCodexDynamicToolHandoffResponse(f.record(), request)).toBeUndefined();
    const g = fixture();
    g.begin();
    for (let i = 0; i < 129; i++) {
      expect(
        g.apply({
          kind: "started",
          request: { requestId: i, call: { ...request.call, callId: `call-${i}` } },
        }),
      ).toBe(true);
    }
    expect(g.record().calls).toHaveLength(128);
    expect(g.record().unsupported).toBe(true);
  });

  it("preserves unknown versions through the binding codec and never backfills their coverage", () => {
    const f = fixture();
    const current = f.get();
    if (current.state !== "active") {
      throw new Error("inactive");
    }
    const opaque = { version: 2, privateFutureField: ["preserve"] };
    const decoded = readCodexAppServerThreadBinding({
      ...current.binding,
      dynamicToolHandoff: opaque,
    });
    expect(decoded?.dynamicToolHandoff).toEqual(opaque);
    expect(readCodexDynamicToolHandoffV1(decoded?.dynamicToolHandoff)).toBeUndefined();
    f.set({ ...current, binding: decoded! });
    expect(f.begin()).toBe(false);
  });

  it("requires exact original turn/source for settlement cleanup and does not erase successor data", () => {
    const f = fixture();
    f.begin();
    f.apply({ kind: "started", request });
    expect(f.apply({ kind: "clear" }, { sourceRunId: "other" })).toBe(false);
    expect(f.apply({ kind: "clear" })).toBe(false); // Native turn is still accepted.
    const current = f.get();
    if (current.state !== "active") {
      throw new Error("inactive");
    }
    f.set({
      ...current,
      binding: { ...current.binding, turnRecovery: { turnId: "turn-2", state: "accepted" } },
    });
    expect(f.apply({ kind: "clear" })).toBe(false);
    f.set({ ...current, binding: { ...current.binding, turnRecovery: undefined } });
    expect(f.apply({ kind: "clear" })).toBe(true);
    expect(f.record()).toBeUndefined();
  });

  it("keeps resolved native policy and hook configuration in admission even for old sparse rows", () => {
    const binding = { threadId: "thread", cwd: "/repo" };
    const policy = {
      approvalPolicy: "on-request" as const,
      approvalsReviewer: "user" as const,
      sandbox: "workspace-write" as const,
      codeModeOnly: true,
    };
    const fingerprint = (config = policy, hook = { hooks: "original" }) =>
      fingerprintCodexDynamicToolHandoffAdmission(
        binding,
        buildCodexDynamicToolHandoffAdmissionConfig(config, hook),
      );
    expect(fingerprint()).not.toBe(
      fingerprint({ ...policy, sandbox: "read-only" as typeof policy.sandbox }),
    );
    expect(fingerprint()).not.toBe(fingerprint(policy, { hooks: "replacement" }));
    expect(fingerprintCodexDynamicToolHandoffAdmission(binding)).not.toBe(fingerprint());
  });

  it("retains exact completed lookup for a live owner after later overflow while rejecting cold admission", () => {
    const f = fixture();
    f.begin();
    f.apply({ kind: "started", request });
    const response = {
      success: true,
      contentItems: [{ type: "inputText" as const, text: "done" }] as [
        { type: "inputText"; text: string },
      ],
    };
    f.apply({ kind: "completed", request, response });
    const overBudget = { ...f.record(), unsupported: true as const };
    expect(isCodexDynamicToolHandoffComplete(overBudget)).toBe(false);
    expect(readCompletedCodexDynamicToolHandoffResponse(overBudget, request)).toEqual(response);
  });

  it("treats object key ordering as equal but tool and namespace changes as different", () => {
    const a = { ...request, call: { ...request.call, arguments: { b: 2, a: 1 } } };
    const b = { ...request, call: { ...request.call, arguments: { a: 1, b: 2 } } };
    expect(codexDynamicToolHandoffRequestIdentity(a)).toEqual(
      codexDynamicToolHandoffRequestIdentity(b),
    );
    expect(
      codexDynamicToolHandoffRequestIdentity({ ...a, call: { ...a.call, tool: "other" } }),
    ).not.toEqual(codexDynamicToolHandoffRequestIdentity(a));
  });
});
