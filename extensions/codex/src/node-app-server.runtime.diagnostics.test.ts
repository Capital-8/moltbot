import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readWorkerCodexRuntime, runCodexNodeAppServer } from "./node-app-server.runtime.js";
import { createCodexNodeAppServerCommand } from "./node-exec-server.js";

const fixture = vi.hoisted(() => ({
  child: undefined as ChildProcessWithoutNullStreams | undefined,
}));
vi.mock("./app-server/managed-binary.js", async (original) => ({
  ...(await original<typeof import("./app-server/managed-binary.js")>()),
  resolveManagedCodexAppServerStartOptions: async () => ({ command: "synthetic-native", args: [] }),
  resolveManagedCodexNativeCommand: () => "synthetic-native",
  isManagedCodexDesktopCommand: () => false,
}));
vi.mock("./app-server/transport-stdio.js", async (original) => ({
  ...(await original<typeof import("./app-server/transport-stdio.js")>()),
  createStdioTransport: async () => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
      const trace = JSON.stringify({level:"WARN",target:"codex_core",fields:{message:"network disconnected; private-token user tool output"}})+"\\n";
      process.stderr.write(trace.repeat(20000), () => process.stdout.write('{"id":1,"result":"still running"}\\n', () => { process.exitCode=7; process.stdin.destroy(); }));
    `,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    fixture.child = child;
    return child;
  },
}));
afterEach(() => {
  fixture.child?.kill();
  fixture.child = undefined;
  vi.unstubAllEnvs();
});

it.each(["autodev-token.mjs", "inference-helper.mjs"])(
  "advertises the command and reads its configured private auth helper (%s)",
  async (name) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "worker-auth-input-"));
    try {
      const directory = path.join(root, "codex-runtime");
      await fs.mkdir(directory, { mode: 0o700 });
      await fs.writeFile(path.join(directory, "version"), "a".repeat(64), { mode: 0o600 });
      await fs.writeFile(path.join(directory, name), "// synthetic helper", { mode: 0o600 });
      const config = (helper: string) =>
        `model_provider="fixture"\n[model_providers.fixture]\nwire_api="responses"\n[model_providers.fixture.auth]\ncommand="node"\nargs=[${JSON.stringify(helper)}]\n`;
      await fs.writeFile(path.join(directory, "config.toml"), config(path.join(directory, name)), {
        mode: 0o600,
      });
      vi.stubEnv("OPENCLAW_STATE_DIR", root);
      vi.stubEnv("OPENCLAW_WORKER_CODEX_CONFIG_VERSION", "a".repeat(64));
      const command = createCodexNodeAppServerCommand();
      expect(command.isAvailable?.({ config: {}, env: { OPENCLAW_STATE_DIR: root } })).toBe(true);
      expect((await readWorkerCodexRuntime()).directory).toBe(directory);
      await fs.writeFile(path.join(directory, "config.toml"), config(path.join(root, name)), {
        mode: 0o600,
      });
      expect(command.isAvailable?.({ config: {}, env: { OPENCLAW_STATE_DIR: root } })).toBe(false);
      await expect(readWorkerCodexRuntime()).rejects.toThrow("command-auth provider is incomplete");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

it.each([false, true])(
  "drains noisy native stderr without disrupting stdout or workspace cleanup (diagnostics blocked=%s)",
  async (blocked) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "worker-diagnostics-"));
    try {
      const directory = path.join(root, "codex-runtime");
      await fs.mkdir(directory, { mode: 0o700 });
      await fs.writeFile(path.join(directory, "version"), "a".repeat(64), { mode: 0o600 });
      await fs.writeFile(path.join(directory, "autodev-token.mjs"), "// synthetic private helper", {
        mode: 0o600,
      });
      await fs.writeFile(
        path.join(directory, "config.toml"),
        `model_provider="fixture"\n[model_providers.fixture]\nwire_api="responses"\n[model_providers.fixture.auth]\ncommand="node"\nargs=[${JSON.stringify(path.join(directory, "autodev-token.mjs"))}]\n`,
        { mode: 0o600 },
      );
      vi.stubEnv("OPENCLAW_STATE_DIR", root);
      const held = Promise.withResolvers<void>();
      const frames: unknown[] = [];
      const release = vi.fn();
      const processes = new Set<() => Promise<void>>();
      try {
        await expect(
          runCodexNodeAppServer({
            workspace: { workspaceDir: root, release },
            io: {
              signal: new AbortController().signal,
              emitChunk: async () => {},
              onInput: () => {},
              frames: {
                onMessage: () => () => {},
                send: async (frame) => {
                  const value = JSON.parse(Buffer.from(frame).toString("utf8")) as {
                    method?: string;
                  };
                  frames.push(value);
                  if (blocked && value.method === "openclaw/workerDiagnostic") {
                    await held.promise;
                  }
                },
              },
            },
            activeProcesses: processes,
            assertExecAuthorized: () => {},
            sessionId: "synthetic-session",
          }),
        ).resolves.toBe("Codex node app-server exited");
        expect(frames).toContainEqual({ id: 1, result: "still running" });
        expect(release).toHaveBeenCalledOnce();
        expect(processes.size).toBe(0);
        expect(frames.length).toBeLessThanOrEqual(24);
        expect(JSON.stringify(frames)).not.toMatch(/private-token|user tool output/);
        if (!blocked) {
          expect(frames).toContainEqual({
            method: "openclaw/workerDiagnostic",
            params: { version: 1, event: "native_exit", code: 7, signal: null },
          });
        }
      } finally {
        held.resolve();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
