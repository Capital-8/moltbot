import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { createSandboxTestContext } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { releaseCodexProbeClient } from "./shared-client.js";
import { createCodexWorkerClientFactory } from "./worker-loss-recovery.js";

const credential = vi.hoisted(() => ({
  revoke: vi.fn<() => Promise<void>>(),
  refresh:
    vi.fn<
      (
        generation?: number,
      ) => Promise<{ generation: number; token: string; expiresAtMs?: number } | undefined>
    >(),
}));
vi.mock("openclaw/plugin-sdk/github-worker-runtime", () => ({
  prepareWorkerGitHubBindingGrant: async () => ({
    binding: { token: "synthetic-worker-token", login: "test-app[bot]" },
    signal: new AbortController().signal,
    assertCurrent: () => {},
    revoke: credential.revoke,
    refresh: credential.refresh,
  }),
}));
beforeEach(() => {
  credential.revoke.mockReset().mockResolvedValue();
  credential.refresh.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function connectWorker(
  ack: "correct" | "wrong" | "missing" | "unsupported" = "correct",
  recovery = false,
) {
  const sent: Array<{ method: string; params?: { generation?: number } }> = [];
  vi.stubEnv("OPENCLAW_WORKER_CODEX_CONFIG_VERSION", "a".repeat(64));
  vi.stubEnv("OPENCLAW_STATE_DIR", "");
  const closed = Promise.withResolvers<void>();
  let listener: ((message: Uint8Array) => void | Promise<void>) | undefined;
  const runtime: Pick<PluginRuntime, "nodes"> = {
    nodes: {
      list: async () => {
        throw new Error("Unexpected node discovery");
      },
      invoke: async () => {
        throw new Error("Unexpected node invocation");
      },
      openDuplex: async () => ({
        send: async (message) => {
          const request = JSON.parse(Buffer.from(message).toString("utf8")) as {
            id?: number;
            method: string;
            params?: { generation?: number };
          };
          sent.push(request);
          if (request.method === "openclaw/github/refresh") {
            if (ack === "unsupported") {
              await listener?.(
                Buffer.from(
                  JSON.stringify({
                    id: request.id,
                    error: { code: -32601, message: "Unknown method" },
                  }),
                ),
              );
            } else if (request.params?.generation === 0 || ack !== "missing") {
              await listener?.(
                Buffer.from(
                  JSON.stringify({
                    id: request.id,
                    result: {
                      generation:
                        request.params?.generation === 0 || ack === "correct"
                          ? request.params?.generation
                          : -1,
                    },
                  }),
                ),
              );
            }
          }
          if (request.method === "initialize") {
            await listener?.(
              Buffer.from(
                JSON.stringify({ id: request.id, result: { userAgent: "codex-cli/0.160.0" } }),
              ),
            );
          }
        },
        onMessage: (next) => {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
        closed: closed.promise,
        close: () => closed.resolve(),
      }),
    },
  };
  const sandbox = {
    ...createSandboxTestContext({ overrides: { backendId: "node" } }),
    placementNodeId: "worker-node",
    placementEnvironmentId: "worker-environment",
    placementSessionId: "worker-session",
    placementOwnerEpoch: 1,
    placementRetainedSession: true,
    placementRequireExistingNativeState: true,
  };
  const openDuplex = vi.spyOn(runtime.nodes, "openDuplex");
  const client = await createCodexWorkerClientFactory({
    runtime,
    sandbox,
    agentId: "main",
    signal: new AbortController().signal,
    assertCurrent: () => {},
    confirmedLossPredecessor: () => recovery,
  })();
  return {
    client,
    openDuplex,
    closed,
    sent,
    deliver: async (message: unknown) => listener?.(Buffer.from(JSON.stringify(message))),
  };
}

it("closes a temporary worker-hosted probe through its tracked isolated ownership", async () => {
  const { client } = await connectWorker();
  try {
    await releaseCodexProbeClient(client, async () => client);
    expect(credential.revoke).toHaveBeenCalledOnce();
    expect(client.getCloseError()).toBeDefined();
  } finally {
    await client.closeAndWait();
  }
});

it("joins caller-owned probe cleanup after its worker transport has already exited", async () => {
  const revocation = Promise.withResolvers<void>();
  credential.revoke.mockImplementation(() => revocation.promise);
  const { client, closed } = await connectWorker();
  closed.resolve();
  await vi.waitFor(() => expect(credential.revoke).toHaveBeenCalledOnce());
  let settled = false;
  const cleanup = releaseCodexProbeClient(client, async () => client, true).then(() => {
    settled = true;
  });
  try {
    await Promise.resolve();
    expect(settled).toBe(false);
    revocation.resolve();
    await cleanup;
    expect(settled).toBe(true);
  } finally {
    revocation.resolve();
    await cleanup;
    await client.closeAndWait();
  }
});

it("joins rejected credential revocation at worker client shutdown and reports it without secrets", async () => {
  const revocation = Promise.withResolvers<void>();
  credential.revoke.mockImplementation(() => revocation.promise);
  const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => {});
  const { client } = await connectWorker();
  const cleanup = client.closeAndWait();
  let settled = false;
  void cleanup.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await vi.waitFor(() => expect(credential.revoke).toHaveBeenCalledOnce());
  expect(settled).toBe(false);
  revocation.reject(new Error("synthetic-worker-token revocation refused"));
  await expect(cleanup).rejects.toThrow("revocation refused");
  expect(warn).toHaveBeenCalledOnce();
  expect(JSON.stringify(warn.mock.calls)).not.toContain("synthetic-worker-token");
});

it.each([
  { native: false, reason: "DISCONNECTED: node disconnected" },
  { native: true, reason: "node worker tunnel owner stopped" },
])(
  "retains remote close cause and distinguishes observed native exit (native=$native)",
  async ({ native, reason }) => {
    credential.revoke.mockResolvedValue();
    const info = vi.spyOn(embeddedAgentLog, "info").mockImplementation(() => {});
    const { client, closed, deliver } = await connectWorker();
    if (native) {
      await deliver({
        method: "openclaw/workerDiagnostic",
        params: {
          version: 1,
          event: "native_exit",
          code: null,
          signal: "SIGTERM",
          message: "secret prompt",
        },
      });
    }
    const failure = new Error(`${reason}; secret-token`);
    closed.reject(failure);
    await vi.waitFor(() => expect(client.getCloseError()).toBeDefined());
    const error = client.getCloseError();
    expect(error?.message).toContain("origin=remote_rejected");
    expect(error?.message).toContain(`exitSource=${native ? "native" : "synthetic"}`);
    expect(error?.cause).toBe(failure);
    const exported = info.mock.calls.map(([message]) => message);
    expect(
      exported.some(
        (message) =>
          message.includes('"event":"duplex_close"') && message.includes('"causeClass":"network"'),
      ),
    ).toBe(true);
    expect(exported.join("\n")).not.toMatch(/secret|prompt/);
    await client.closeAndWait();
  },
);

it("acknowledges only the installed credential generation and stops polling on close", async () => {
  vi.useFakeTimers();
  const update = { generation: 1, token: "synthetic-renewed", expiresAtMs: Date.now() + 3_600_000 };
  credential.refresh.mockImplementation(async (generation) =>
    generation === 0 ? update : undefined,
  );
  const { client, sent } = await connectWorker();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(
    sent.filter(
      (request) =>
        request.method === "openclaw/github/refresh" &&
        request.params &&
        request.params.generation !== 0,
    ),
  ).toEqual([expect.objectContaining({ params: update })]);
  expect(credential.refresh.mock.calls).toEqual([[0], [1]]);
  await client.closeAndWait();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(credential.refresh).toHaveBeenCalledTimes(2);
  expect(credential.revoke).toHaveBeenCalledOnce();
});

it.each(["wrong", "missing"] as const)(
  "never acknowledges %s installation and closes without retrying execution",
  async (ack) => {
    vi.useFakeTimers();
    credential.refresh.mockResolvedValue({ generation: 1, token: "synthetic-renewed" });
    const { client, sent } = await connectWorker(ack);
    await vi.advanceTimersByTimeAsync(45_001);
    expect(client.getCloseError()?.message).toContain("local_credential_failure");
    expect(credential.refresh.mock.calls).toEqual([[0]]);
    expect(
      sent.filter(
        (request) =>
          request.method === "openclaw/github/refresh" &&
          request.params &&
          request.params.generation !== 0,
      ),
    ).toHaveLength(1);
    await client.closeAndWait();
    expect(credential.revoke).toHaveBeenCalledOnce();
  },
);

it("refuses an unmatched old worker before returning a usable client", async () => {
  await expect(connectWorker("unsupported")).rejects.toThrow("Unknown method");
  expect(credential.refresh).not.toHaveBeenCalled();
  expect(credential.revoke).toHaveBeenCalledOnce();
});

it.each([false, true])(
  "keeps the retained one-start fence with confirmed loss=%s",
  async (recovery) => {
    const { client, openDuplex } = await connectWorker("correct", recovery);
    try {
      const params = openDuplex.mock.calls[0]?.[0].params;
      expect(params).toMatchObject({
        placement: {
          retainedSession: true,
          ...(recovery ? {} : { requireExistingNativeState: true }),
        },
      });
      if (recovery) {
        expect(params).toHaveProperty("placement");
        expect(params).not.toHaveProperty("placement.requireExistingNativeState");
      }
    } finally {
      await client.closeAndWait();
    }
  },
);
