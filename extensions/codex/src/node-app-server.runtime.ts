import type { ChildProcessWithoutNullStreams } from "node:child_process";
/** One placement-bound Codex app-server process on a managed cloud node. */
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import type { WorkerGitHubLaunchBinding } from "openclaw/plugin-sdk/github-worker-runtime";
import type { OpenClawPluginNodeHostCommandIo } from "openclaw/plugin-sdk/node-host";
import type { OpenClawPluginNodeHostCommand } from "openclaw/plugin-sdk/plugin-entry";
import { createBoundedLineFramer } from "openclaw/plugin-sdk/process-runtime";
import { sanitizeEnvVars } from "openclaw/plugin-sdk/sandbox";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  isManagedCodexDesktopCommand,
  resolveManagedCodexAppServerStartOptions,
  resolveManagedCodexNativeCommand,
} from "./app-server/managed-binary.js";
import { createStdioTransport } from "./app-server/transport-stdio.js";
import { createWorkerDiagnosticForwarder } from "./app-server/worker-diagnostics.js";
import { resolveCodexWorkerAuthHelper } from "./node-app-server-command.js";
import { createCodexNodeAppServerProcessOwner } from "./node-app-server-process-owner.js";
import { createCodexNodeWorkspaceEnvironment } from "./node-app-server-workspace-environment.js";
import {
  createCodexNodeGitHubCredential,
  type CodexNodeGitHubCredential,
} from "./node-github-credential.js";
import { createCodexNodeResourceReadiness } from "./node-resource-readiness.js";

type NodeCommandContext = NonNullable<Parameters<OpenClawPluginNodeHostCommand["handle"]>[2]>;

const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const PLATFORM_ENV = /^(?:SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|TMPDIR)$/iu;

async function readPrivateFile(file: string): Promise<string> {
  const stat = await fs.lstat(file);
  if (
    !stat.isFile() ||
    stat.size > 16 * 1024 ||
    (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
  ) {
    throw new Error("Cloud worker Codex private configuration is unsafe");
  }
  return await fs.readFile(file, "utf8");
}

/** Only the worker process reads these lease-private settings. */
export async function readWorkerCodexRuntime() {
  const stateDir = resolveStateDir(process.env);
  const directory = path.join(stateDir, "codex-runtime");
  const directoryStat = await fs.lstat(directory);
  if (
    !directoryStat.isDirectory() ||
    (await fs.realpath(directory)) !== directory ||
    (process.platform !== "win32" && (directoryStat.mode & 0o077) !== 0)
  ) {
    throw new Error("Cloud worker Codex settings directory is unsafe");
  }
  const [version, config] = await Promise.all([
    readPrivateFile(path.join(directory, "version")),
    readPrivateFile(path.join(directory, "config.toml")),
  ]);
  if (
    !/^[a-f0-9]{64}$/.test(version) ||
    (process.env.OPENCLAW_WORKER_CODEX_CONFIG_VERSION !== undefined &&
      version !== process.env.OPENCLAW_WORKER_CODEX_CONFIG_VERSION)
  ) {
    throw new Error("Cloud worker Codex configuration version is invalid");
  }
  const helper = resolveCodexWorkerAuthHelper(config, directory);
  await readPrivateFile(helper);
  return { directory, config };
}

function nodeAppServerMessage(frame: Uint8Array): Buffer {
  if (frame.byteLength < 1 || frame.byteLength > MAX_FRAME_BYTES) {
    throw new Error("Codex node app-server frame is invalid");
  }
  const bytes = Buffer.from(frame);
  if (bytes.includes(0x0a) || bytes.includes(0x0d)) {
    throw new Error("Codex node app-server frame must be one JSON line");
  }
  try {
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Codex node app-server frame is not JSON");
  }
  return bytes;
}

export async function runCodexNodeAppServer(params: {
  workspace: Awaited<ReturnType<NonNullable<NodeCommandContext["acquireManagedWorkspaceAsync"]>>>;
  io: OpenClawPluginNodeHostCommandIo;
  activeProcesses: Set<() => Promise<void>>;
  assertExecAuthorized: () => void;
  github?: WorkerGitHubLaunchBinding;
  sessionId: string;
  resourcePreparationRequired?: boolean;
  retainedSession?: true;
  requireExistingNativeState?: true;
  placement?: { environmentId: string; ownerEpoch: number; sessionKey: string };
}): Promise<string> {
  const { io } = params;
  const resources = createCodexNodeResourceReadiness({
    required: params.resourcePreparationRequired,
    signal: io.signal,
    assertCurrent: () => {
      params.assertExecAuthorized();
      params.workspace.processEnvironment?.assertCurrent();
    },
  });
  const workspace = { ...params.workspace, repositoryReadiness: resources.readiness };
  const frames = io.frames;
  if (!frames) {
    workspace.release();
    throw new Error("Codex node app-server requires duplex frames");
  }
  let child: ChildProcessWithoutNullStreams | undefined;
  let unsubscribe: (() => void) | undefined;
  let tempGitHub: string | undefined;
  let github: CodexNodeGitHubCredential | undefined;
  let executionFailed = false;
  let stopped = false;
  let writes = Promise.resolve();
  let failure: unknown;
  let diagnostics: ReturnType<typeof createWorkerDiagnosticForwarder> | undefined;
  let executionEnvironment:
    | Awaited<ReturnType<typeof createCodexNodeWorkspaceEnvironment>>
    | undefined;
  const internalRequests = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  const owner = createCodexNodeAppServerProcessOwner({
    child: () => child,
    unsubscribe: () => unsubscribe?.(),
    release: async () => {
      stopped = true;
      await writes.catch(() => {});
      await executionEnvironment?.close();
      if (tempGitHub) {
        await fs.rm(tempGitHub, { recursive: true, force: true });
      }
      workspace.release();
    },
    activeProcesses: params.activeProcesses,
  });
  try {
    io.signal.throwIfAborted();
    const runtime = await readWorkerCodexRuntime();
    const sessionHome = path.join(
      runtime.directory,
      "sessions",
      createHash("sha256").update(params.sessionId).digest("hex"),
    );
    const priorSessionHome = params.retainedSession
      ? await fs.lstat(sessionHome).catch((error: unknown) => {
          if (extractErrorCode(error) === "ENOENT") {
            return undefined;
          }
          throw error;
        })
      : undefined;
    let retainedThreadStarted = Boolean(priorSessionHome);
    if (params.requireExistingNativeState) {
      const existing = priorSessionHome ?? (await fs.lstat(sessionHome).catch(() => undefined));
      if (!existing?.isDirectory() || existing.isSymbolicLink()) {
        throw new Error(
          "Retained Codex session home is missing; no input was submitted and replacement is refused",
        );
      }
    } else {
      await fs.mkdir(sessionHome, { recursive: true, mode: 0o700 });
    }
    await fs.writeFile(path.join(sessionHome, "config.toml"), runtime.config, { mode: 0o600 });
    let githubEnv: Record<string, string> = {};
    if (params.github) {
      tempGitHub = await fs.mkdtemp(path.join(runtime.directory, "github-"));
      await fs.chmod(tempGitHub, 0o700);
      github = await createCodexNodeGitHubCredential({
        profileDir: tempGitHub,
        binding: params.github,
        assertCurrent: () => {
          io.signal.throwIfAborted();
          if (stopped) {
            throw new Error("Worker GitHub profile closed");
          }
          params.assertExecAuthorized();
          workspace.processEnvironment?.assertCurrent();
        },
      });
      githubEnv = github.environment;
    }
    const resolved = await resolveManagedCodexAppServerStartOptions({
      transport: "stdio",
      command: "codex",
      commandSource: "managed",
      managedCommandOrder: "package-first",
      args: ["app-server", "--listen", "stdio://"],
      headers: {},
    });
    const native = resolveManagedCodexNativeCommand(resolved.command);
    if (!native || isManagedCodexDesktopCommand(resolved.command)) {
      throw new Error("Cloud worker requires its pinned Codex binary");
    }
    const baseEnv = sanitizeEnvVars(process.env, {
      strictMode: true,
      customAllowedPatterns: [PLATFORM_ENV],
    }).allowed;
    const assertSpawnAuthorized = () => {
      params.assertExecAuthorized();
      workspace.processEnvironment?.assertCurrent();
    };
    assertSpawnAuthorized();
    const processEnv = workspace.processEnvironment?.prepare(baseEnv) ?? baseEnv;
    child = await createStdioTransport(
      {
        transport: "stdio",
        command: native,
        commandSource: "resolved-managed",
        args: resolved.args,
        headers: {},
        cwd: workspace.workspaceDir,
        env: {
          HOME: workspace.homeDir ?? sessionHome,
          CODEX_HOME: sessionHome,
          LOG_FORMAT: "json",
          PATH: process.env.PATH ?? "",
          ...githubEnv,
          ...(process.platform === "win32"
            ? { USERPROFILE: workspace.homeDir ?? sessionHome }
            : {}),
        },
        clearEnv: ["NODE_OPTIONS", "OPENAI_API_KEY", "OPENAI_API_PROXY_KEY", "CODEX_API_KEY"],
      },
      processEnv,
      assertSpawnAuthorized,
    );
    const activeChild = child;
    diagnostics = createWorkerDiagnosticForwarder((frame) => frames.send(frame));
    const activeDiagnostics = diagnostics;
    activeChild.once("exit", (code, signal) => activeDiagnostics.nativeExit(code, signal));
    owner.observe(activeChild);
    const requestInternal = (method: string, requestParams: Record<string, unknown>) => {
      const id = `openclaw-environment-${randomUUID()}`;
      return new Promise<unknown>((resolve, reject) => {
        const onAbort = () => {
          internalRequests.delete(id);
          reject(new Error("Worker execution environment registration cancelled"));
        };
        internalRequests.set(id, {
          resolve(value) {
            io.signal.removeEventListener("abort", onAbort);
            resolve(value);
          },
          reject(error) {
            io.signal.removeEventListener("abort", onAbort);
            reject(error);
          },
        });
        io.signal.addEventListener("abort", onAbort, { once: true });
        if (io.signal.aborted) {
          onAbort();
          return;
        }
        activeChild.stdin.write(
          JSON.stringify({ id, method, params: requestParams }) + "\n",
          (error) => {
            if (error) {
              internalRequests.get(id)?.reject(error);
              internalRequests.delete(id);
            }
          },
        );
      });
    };
    const outgoing = (async () => {
      const framer = createBoundedLineFramer(
        MAX_FRAME_BYTES + 1,
        "Codex node app-server response exceeded 64 MiB",
      );
      for await (const chunk of activeChild.stdout) {
        for (const frame of framer.push(Buffer.from(chunk))) {
          const message = nodeAppServerMessage(frame);
          const decoded: unknown = JSON.parse(message.toString("utf8"));

          const internal =
            isRecord(decoded) && typeof decoded.id === "string"
              ? internalRequests.get(decoded.id)
              : undefined;
          if (internal && isRecord(decoded)) {
            internalRequests.delete(String(decoded.id));
            if (decoded.error) {
              internal.reject(new Error("Worker execution environment registration failed"));
            } else {
              internal.resolve(decoded.result);
            }
            continue;
          }
          await frames.send(
            workspace.processEnvironment
              ? nodeAppServerMessage(
                  Buffer.from(workspace.processEnvironment.redactOutput(message.toString("utf8"))),
                )
              : message,
          );
        }
      }
      if (framer.pendingByteLength) {
        throw new Error("Codex node app-server ended with an incomplete frame");
      }
    })();
    const stderr = (async () => {
      // Export only bounded classifications; native text may contain prompts or credentials.
      for await (const chunk of activeChild.stderr) {
        activeDiagnostics.append(Buffer.from(chunk));
      }
    })();
    const repositoryOperations = new Set<Promise<void>>();
    let environmentRegistration: Promise<void> | undefined;
    const ensureExecutionEnvironment = () =>
      (environmentRegistration ??= (async () => {
        executionEnvironment = await createCodexNodeWorkspaceEnvironment({
          workspace,
          signal: io.signal,
          assertExecAuthorized: assertSpawnAuthorized,
          commandEnvironment: github,
        });
        await requestInternal("environment/add", {
          environmentId: executionEnvironment.id,
          execServerUrl: executionEnvironment.url,
        });
        io.signal.throwIfAborted();
        assertSpawnAuthorized();
      })());
    unsubscribe = frames.onMessage((frame) => {
      let message = nodeAppServerMessage(frame);
      const request: unknown = JSON.parse(message.toString("utf8"));
      if (isRecord(request) && request.method === "openclaw/github/refresh") {
        // Private OpenClaw control never reaches the native model or its tool protocol.
        writes = writes.then(async () => {
          io.signal.throwIfAborted();
          assertSpawnAuthorized();
          if (!github || (typeof request.id !== "string" && !Number.isSafeInteger(request.id))) {
            throw new Error("Worker GitHub refresh has no admitted profile");
          }
          const result = await github.install(request.params);
          io.signal.throwIfAborted();
          assertSpawnAuthorized();
          await frames.send(Buffer.from(JSON.stringify({ id: request.id, result })));
        });
        return writes;
      }
      const bindCommandEnvironment = () => {
        if (
          github &&
          isRecord(request) &&
          request.method === "command/exec" &&
          isRecord(request.params)
        ) {
          request.params.env = {
            ...(isRecord(request.params.env) ? request.params.env : {}),
            ...github.launchEnvironment(),
          };
          message = nodeAppServerMessage(Buffer.from(JSON.stringify(request)));
        }
      };
      const resourceControl = resources.settle(request);
      if (resourceControl) {
        return frames.send(Buffer.from(JSON.stringify(resourceControl)));
      }
      if (
        workspace.repositoryReadiness &&
        isRecord(request) &&
        typeof request.method === "string" &&
        (request.method.startsWith("fs/") ||
          request.method === "command/exec" ||
          request.method.startsWith("fuzzyFileSearch/"))
      ) {
        if (repositoryOperations.size >= 64) {
          throw new Error("Too many pending repository operations");
        }
        const operation = (async () => {
          try {
            await workspace.repositoryReadiness!.wait(io.signal);
            io.signal.throwIfAborted();
            assertSpawnAuthorized();
            workspace.repositoryReadiness!.assertCurrent();
            bindCommandEnvironment();
            activeChild.stdin.write(Buffer.concat([message, Buffer.from("\n")]));
          } catch {
            if (!io.signal.aborted) {
              await frames.send(
                Buffer.from(
                  JSON.stringify({
                    id: request.id,
                    error: {
                      code: -32001,
                      message: "Repository preparation is unavailable; this operation did not run.",
                    },
                  }),
                ),
              );
            }
          }
        })();
        repositoryOperations.add(operation);
        void operation.finally(() => repositoryOperations.delete(operation)).catch(() => undefined);
        return operation;
      }
      writes = writes.then(async () => {
        const decoded: unknown = JSON.parse(message.toString("utf8"));
        if (params.retainedSession && isRecord(decoded) && decoded.method === "thread/start") {
          if (retainedThreadStarted) {
            await frames.send(
              Buffer.from(
                JSON.stringify({
                  id: decoded.id,
                  error: {
                    code: -32001,
                    message:
                      "Retained Codex session requires its existing thread; a fresh thread was refused before input submission.",
                  },
                }),
              ),
            );
            return;
          }
          // An uncertain initial start is not permission to create another conversation.
          retainedThreadStarted = true;
        }
        if (
          workspace.repositoryReadiness &&
          isRecord(decoded) &&
          ["thread/start", "thread/resume", "turn/start"].includes(String(decoded.method))
        ) {
          await ensureExecutionEnvironment();
          if (!executionEnvironment || !isRecord(decoded.params)) {
            throw new Error("Worker execution environment selection is unavailable");
          }
          executionEnvironment.signal.throwIfAborted();
          assertSpawnAuthorized();
          const original = decoded.params.environments;
          // Explicit no-tools policy stays disabled; an omitted/native environment selects this owner.
          decoded.params.environments =
            Array.isArray(original) && original.length === 0
              ? []
              : [{ environmentId: executionEnvironment.id, cwd: workspace.workspaceDir }];
          message = nodeAppServerMessage(Buffer.from(JSON.stringify(decoded)));
        }
        io.signal.throwIfAborted();
        assertSpawnAuthorized();
        bindCommandEnvironment();
        if (!activeChild.stdin.write(Buffer.concat([message, Buffer.from("\n")]))) {
          await once(activeChild.stdin, "drain", { signal: io.signal });
        }
      });
      return writes;
    });
    const exit = once(activeChild, "exit", { signal: io.signal });
    await Promise.race([
      Promise.all([outgoing, stderr, exit]),
      new Promise<never>((_resolve, reject) => {
        io.signal.addEventListener(
          "abort",
          () => {
            const reason: unknown = io.signal.reason;
            let error: Error;
            try {
              error =
                reason instanceof Error
                  ? reason
                  : new Error("Codex worker aborted", { cause: reason });
            } catch {
              error = new Error("Codex worker aborted", { cause: reason });
            }
            reject(error);
          },
          { once: true },
        );
      }),
    ]);
  } catch (error) {
    executionFailed = true;
    failure = error;
  }
  for (const request of internalRequests.values()) {
    request.reject(new Error("Worker app-server closed before environment registration"));
  }
  internalRequests.clear();
  try {
    await owner.stop();
  } catch (error) {
    if (executionFailed) {
      throw new AggregateError([failure, error], "Codex worker execution and cleanup failed", {
        cause: error,
      });
    }
    throw error;
  } finally {
    await diagnostics?.finish();
  }
  if (executionFailed) {
    throw failure instanceof Error
      ? failure
      : new Error("Codex worker execution failed", { cause: failure });
  }
  return "Codex node app-server exited";
}
