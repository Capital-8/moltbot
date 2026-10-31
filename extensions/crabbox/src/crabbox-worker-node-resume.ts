import type { WorkerProvider } from "openclaw/plugin-sdk/plugin-entry";
import { crabboxCommandError, leaseRunArgs, runCrabboxCommand } from "./crabbox-worker-command.js";
import { createCrabboxNodeProcessRuntime } from "./crabbox-worker-node-process.js";
import { assertCrabboxLeaseId, parseCrabboxProfile } from "./crabbox-worker-profile.js";
import { wrapCrabboxNodeScript } from "./crabbox-worker-script.js";

type ResumeRequest = Parameters<NonNullable<WorkerProvider["resumeNode"]>>[0];

/** No setup, artifact download, enrollment credential, or repository command enters recovery. */
export function createCrabboxNodeResumeScript(request: ResumeRequest): string {
  const script = `const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
(async () => {
  process.umask(0o077);
  const home = fs.realpathSync(os.homedir());
  const leaseId = ${JSON.stringify(request.leaseId)};
  const mode = "resume";
  const displayName = "Cloud worker";
  const setPhase = () => {};
  const stateDir = path.join(home, ".openclaw", "cloud-workers", leaseId);
  const runtimeDir = path.join(home, ".openclaw-worker", "node-runtimes", ${JSON.stringify(request.nodeBootstrapSha256)});
  const runtimeLink = path.join(stateDir, "runtime");
  const cli = path.join(runtimeDir, "node_modules", "openclaw", "openclaw.mjs");
  const pidFile = path.join(stateDir, "node.pid");
  const launchFile = path.join(stateDir, "node-launch.json");
  const setupFile = path.join(stateDir, "setup-code");
  if (!fs.lstatSync(stateDir).isDirectory() || fs.realpathSync(stateDir) !== stateDir || !fs.lstatSync(runtimeDir).isDirectory() || fs.realpathSync(runtimeDir) !== runtimeDir || !fs.lstatSync(runtimeLink).isSymbolicLink() || fs.realpathSync(runtimeLink) !== runtimeDir) throw new Error("Cloud worker saved runtime is missing or changed; resume refused");
  const manifest = JSON.parse(fs.readFileSync(path.join(runtimeDir, "node_modules", "openclaw", "package.json"), "utf8"));
  if (manifest.name !== "openclaw" || manifest.version !== ${JSON.stringify(request.openclawVersion)}) throw new Error("Cloud worker saved package identity changed; resume refused");
  const nodeEnv = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  nodeEnv.PATH = path.dirname(process.execPath) + path.delimiter + path.join(runtimeDir, "node_modules", "openclaw", "dist", "worker-tools", "bin") + path.delimiter + (nodeEnv.PATH || "");
  // The supported identity reader never creates a missing enrollment. The node
  // runner independently requires the saved configuration and paired token.
  const identity = spawnSync(process.execPath, [cli, "node", "identity", "--json"], { cwd: runtimeDir, env: nodeEnv, encoding: "utf8", timeout: 30000, maxBuffer: 65536 });
  if (identity.status !== 0 || JSON.parse(identity.stdout).deviceId !== ${JSON.stringify(request.deviceId)}) throw new Error("Cloud worker saved device identity changed; resume refused");
  ${createCrabboxNodeProcessRuntime(undefined, request.leaseId, request.deviceId)}
  if (!reuseNodeProcess()) await launchNodeProcess();
})().catch((error) => { console.error(error.message); process.exitCode = 1; });`;
  return wrapCrabboxNodeScript(script, "linux", "CRABBOX_NODE_RESUME_SCRIPT");
}

export function createCrabboxNodeResumer(options: {
  signal: AbortSignal;
  resolveBinary: (binary?: string, signal?: AbortSignal) => Promise<{ binary: string }>;
}): NonNullable<WorkerProvider["resumeNode"]> {
  return async (request) => {
    const signal = AbortSignal.any([request.signal, options.signal]);
    const assertCurrent = () => {
      signal.throwIfAborted();
      request.assertCurrent();
    };
    assertCurrent();
    const profile = parseCrabboxProfile(request.profile);
    // Desktop launchers own their session environment and process receipts.
    if (request.platform !== "linux" || profile.desktop) {
      return;
    }
    assertCrabboxLeaseId(request.leaseId);
    const { binary } = await options.resolveBinary(profile.binary, signal);
    assertCurrent();
    const result = await runCrabboxCommand({
      action: "node resume",
      binary,
      args: [
        ...leaseRunArgs({ binary, provider: profile.provider, id: request.leaseId }),
        "--no-hydrate",
      ],
      input: createCrabboxNodeResumeScript(request),
      signal,
      timeoutMs: 60_000,
    });
    assertCurrent();
    if (result.termination !== "exit" || result.code !== 0) {
      throw crabboxCommandError("node resume", result);
    }
  };
}
