/** Gateway-side stdio facade over one authorized worker app-server duplex. */
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  prepareWorkerGitHubBindingGrant,
  type WorkerGitHubBindingRefresh,
} from "openclaw/plugin-sdk/github-worker-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { SandboxContext } from "openclaw/plugin-sdk/sandbox";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveCodexWorkerAppServerCommand } from "../node-app-server-command.js";
import { CodexAppServerClient } from "./client.js";
import { readCodexPlacementWorkspaceIdentity } from "./sandbox-exec-server.js";
import { trackIsolatedCodexAppServerClient } from "./shared-client.js";
import type { CodexAppServerTransport } from "./transport.js";
import {
  createWorkerDiagnosticReceiver,
  type WorkerDuplexCloseOrigin,
} from "./worker-diagnostics.js";

const MAX_FRAME_BYTES = 64 * 1024 * 1024;

export async function startWorkerCodexAppServerClient(params: {
  runtime: Pick<PluginRuntime, "nodes">;
  sandbox: SandboxContext;
  agentId: string;
  signal: AbortSignal;
  assertCurrent: () => void;
  confirmedLossPredecessor?: true;
}): Promise<CodexAppServerClient> {
  const { sandbox, runtime, signal, assertCurrent } = params;
  if (
    !sandbox.enabled ||
    !("placementNodeId" in sandbox) ||
    typeof sandbox.placementNodeId !== "string"
  ) {
    throw new Error("Codex worker app-server requires an exact managed placement node");
  }
  const workspace = readCodexPlacementWorkspaceIdentity(sandbox);
  // Only associated confirmed loss permits an absent home; keep the independent one-start fence.
  if (params.confirmedLossPredecessor) {
    delete workspace.requireExistingNativeState;
  }
  const agentId = params.agentId;
  assertCurrent();
  signal.throwIfAborted();
  let grant: Awaited<ReturnType<typeof prepareWorkerGitHubBindingGrant>> | undefined;
  if (agentId) {
    grant = await prepareWorkerGitHubBindingGrant({
      sessionId: workspace.sessionId,
      sessionKey: workspace.sessionKey,
      agentId,
      signal,
      assertCurrent: () => {
        signal.throwIfAborted();
        assertCurrent();
        return true;
      },
    });
  }
  let acquiredChannel: Awaited<ReturnType<PluginRuntime["nodes"]["openDuplex"]>> | undefined;
  try {
    assertCurrent();
    grant?.assertCurrent?.();
    const selectedCommand = resolveCodexWorkerAppServerCommand(process.env, true);
    acquiredChannel = await runtime.nodes.openDuplex({
      nodeId: sandbox.placementNodeId,
      command: selectedCommand,
      params: {
        placement: { cwd: sandbox.containerWorkdir, ...workspace },
        authorization: "session-full",
        ...(sandbox.resourceReadiness ? { resourcePreparationRequired: true } : {}),
        ...(grant ? { github: grant.binding } : {}),
      },
      sessionKey: sandbox.sessionKey,
      timeoutMs: 0,
      maxMessageBytes: MAX_FRAME_BYTES,
      maxOutstandingDeliveryBytes: MAX_FRAME_BYTES + 2 * 1024 * 1024,
      signal: grant?.signal ? AbortSignal.any([signal, grant.signal]) : signal,
      assertCurrent: () => {
        assertCurrent();
        grant?.assertCurrent?.();
      },
    });
    assertCurrent();
    grant?.assertCurrent?.();
  } catch (error) {
    try {
      acquiredChannel?.close();
    } finally {
      await grant?.revoke();
    }
    throw error;
  }
  const channel = acquiredChannel;
  const events = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let exitCode: number | null = null;
  let signalCode: string | null = null;
  let exitError: Error | undefined;
  const diagnostics = createWorkerDiagnosticReceiver();
  let closed = false;
  let grantRevocation: Promise<void> | undefined;
  let renewalTimer: ReturnType<typeof setInterval> | undefined;
  let renewalWork: Promise<void> | undefined;
  let pending = Buffer.alloc(0);
  const close = (origin: WorkerDuplexCloseOrigin, error?: unknown) => {
    if (closed) {
      return;
    }
    closed = true;
    clearInterval(renewalTimer);
    grantRevocation = Promise.resolve().then(async () => {
      try {
        await grant?.revoke();
      } finally {
        await renewalWork?.catch(() => {});
      }
    });
    // Synchronous exit observers cannot join cleanup; the transport close owner does.
    void grantRevocation.catch(() => {
      embeddedAgentLog.warn(
        "Worker GitHub credential cleanup failed; the token may remain valid until expiry.",
        { origin },
      );
    });
    const disposition = diagnostics.close(origin, error);
    exitError = disposition.error;
    exitCode = disposition.code;
    signalCode = disposition.signal;
    channel.close();
    stdout.end();
    stderr.end();
    events.emit("exit", exitCode, signalCode);
  };
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      if (closed) {
        callback(new Error("Codex worker app-server channel is closed"));
        return;
      }
      pending = Buffer.concat([pending, Buffer.from(chunk)]);
      if (pending.length > MAX_FRAME_BYTES + 1) {
        callback(new Error("Codex worker app-server request exceeds 64 MiB"));
        return;
      }
      const messages: Buffer[] = [];
      let newline: number;
      while ((newline = pending.indexOf(0x0a)) !== -1) {
        const frame = pending.subarray(0, newline);
        pending = pending.subarray(newline + 1);
        messages.push(frame);
      }
      void (async () => {
        for (const message of messages) {
          await channel.send(message);
        }
      })().then(
        () => callback(),
        (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
      );
    },
    final(callback) {
      close("local_stdin_final");
      callback();
    },
  });
  const unsubscribe = channel.onMessage(async (message) => {
    if (closed) {
      return;
    }
    if (diagnostics.consume(message)) {
      return;
    }
    if (message.byteLength > MAX_FRAME_BYTES) {
      close(
        "local_response_too_large",
        new Error("Codex worker app-server response exceeds 64 MiB"),
      );
      return;
    }
    if (!stdout.write(Buffer.concat([Buffer.from(message), Buffer.from("\n")]))) {
      await new Promise<void>((resolve) => {
        stdout.once("drain", resolve);
      });
    }
  });
  void channel.closed.then(
    () => close("remote_resolved"),
    (error: unknown) => close("remote_rejected", error),
  );
  const transport: CodexAppServerTransport = {
    stdin,
    stdout,
    stderr,
    get exitCode() {
      return exitCode;
    },
    get signalCode() {
      return signalCode;
    },
    get exitError() {
      return exitError;
    },
    kill: () => {
      close("local_kill", new Error("Codex worker app-server stopped"));
      return true;
    },
    once: (event, listener) => events.once(event, listener),
    off: (event, listener) => events.off(event, listener),
    waitForCleanup: () => grantRevocation ?? Promise.resolve(),
  };
  const client = CodexAppServerClient.fromTransport(transport);
  trackIsolatedCodexAppServerClient(client);
  if (sandbox.resourceReadiness) {
    const readiness = sandbox.resourceReadiness;
    // This exact duplex owns the resource gate; turn/start does not join delivery.
    void (async () => {
      let status: "ready" | "failed" = "ready";
      try {
        await readiness.wait(signal);
        readiness.assertCurrent();
      } catch {
        status = "failed";
      }
      signal.throwIfAborted();
      assertCurrent();
      await client.request("openclaw/resources/settle", { status }, { signal });
      assertCurrent();
    })().catch(() => {
      if (!signal.aborted && !closed) {
        close("local_resource_failure", new Error("Worker private resource readiness failed"));
      }
    });
  }
  client.addTransportExitHandler(() => unsubscribe());
  if (signal.aborted) {
    close("local_abort", signal.reason);
  }
  try {
    await client.initialize();
    assertCurrent();
    if (grant) {
      const currentGrant = grant;
      const assertRenewalCurrent = () => {
        signal.throwIfAborted();
        assertCurrent();
        currentGrant.assertCurrent();
        if (closed) {
          throw new Error("Worker GitHub transport closed");
        }
      };
      const install = async (update: WorkerGitHubBindingRefresh, errorMessage: string) => {
        const acknowledged = await client.request("openclaw/github/refresh", update, {
          timeoutMs: 15_000,
          signal: currentGrant.signal,
          assertCurrent: assertRenewalCurrent,
        });
        assertRenewalCurrent();
        if (!isRecord(acknowledged) || acknowledged.generation !== update.generation) {
          throw new Error(errorMessage);
        }
      };
      // Initial installation and renewal must both acknowledge the exact generation.
      await install(
        { generation: 0, token: currentGrant.binding.token },
        "Worker GitHub credential installer is unavailable; update the worker bundle",
      );
      let installedGeneration = 0;
      renewalTimer = setInterval(() => {
        if (closed || renewalWork) {
          return;
        }
        renewalWork = (async () => {
          assertRenewalCurrent();
          const update = await currentGrant.refresh(installedGeneration);
          assertRenewalCurrent();
          if (!update) {
            return;
          }
          await install(update, "Worker GitHub credential installation was not acknowledged");
          installedGeneration = update.generation;
          await currentGrant.refresh(installedGeneration);
          assertRenewalCurrent();
        })()
          .catch(() => {
            // Unknown installation cannot extend the old credential's admitted lifetime.
            if (!closed) {
              close(
                "local_credential_failure",
                new Error("Worker GitHub credential renewal failed"),
              );
            }
          })
          .finally(() => {
            renewalWork = undefined;
          });
      }, 30_000);
      renewalTimer.unref?.();
    }
    return client;
  } catch (error) {
    await client.closeAndWait();
    throw error;
  }
}
