import type { WorkerProvider } from "openclaw/plugin-sdk/plugin-entry";
import { createCrabboxXfceSessionEnvironment } from "./crabbox-worker-desktop-setup.js";
import {
  CRABBOX_NPM_RUNTIME_INSTALL_SOURCE,
  createCrabboxNodeProcessRuntime,
} from "./crabbox-worker-node-process.js";
import type { CrabboxOperatingSystem } from "./crabbox-worker-profile.js";
import {
  CRABBOX_RUNTIME_VERIFICATION_SOURCE,
  type CrabboxRuntimeInstallationIdentity,
} from "./crabbox-worker-runtime-verification.js";
import {
  CLOUD_BOOTSTRAP_TOKEN_ENV,
  CLOUD_SETUP_CODE_ENV,
  CLOUD_WORKER_CODEX_ENV,
  CRABBOX_LINUX_PLATFORM_TRUST_SETUP,
  createCrabboxWorkerStateDirScript,
  wrapCrabboxNodeScript,
} from "./crabbox-worker-script.js";
import { CRABBOX_SETUP_TIMEOUT_MS } from "./crabbox-worker-timeouts.js";

// Tolerate brief network pauses while resuming stalls well before the command deadline.
const CLOUD_BOOTSTRAP_DOWNLOAD_IDLE_TIMEOUT_MS = 2 * 60_000;

export type CrabboxWorkerNodeEnrollment = Awaited<
  ReturnType<
    NonNullable<NonNullable<Parameters<WorkerProvider["provision"]>[2]>["beginNodeEnrollment"]>
  >
>;

export function createCrabboxNodeEnrollmentSetup(params: {
  enrollment: CrabboxWorkerNodeEnrollment;
  desktop?: boolean;
  desktopSetup?: string;
  leaseId: string;
  target?: CrabboxOperatingSystem;
}): { command: string; forwardedEnv: Record<string, string> } {
  return createCrabboxNodeSetup({
    ...params,
    nodeBootstrap: params.enrollment.nodeBootstrap,
    workerCodex: params.enrollment.workerCodex,
  });
}

export type CrabboxWorkerNodeRuntimePreparation = Awaited<
  ReturnType<
    NonNullable<NonNullable<Parameters<WorkerProvider["provision"]>[2]>["prepareNodeRuntime"]>
  >
>;

export function createCrabboxNodeRuntimeSetup(params: {
  nodeBootstrap: CrabboxWorkerNodeEnrollment["nodeBootstrap"];
  workerBundle: CrabboxWorkerNodeRuntimePreparation["workerBundle"];
  leaseId: string;
  target?: CrabboxOperatingSystem;
}): { command: string; forwardedEnv: Record<string, string> } {
  return createCrabboxNodeSetup(params);
}

/** Install verified local runtime archives without enrollment or a logical lease. */
export function createCrabboxOfflineRuntimeSetup(params: {
  nodeBootstrap: {
    install?: "bundle" | "npm";
    localPath: string;
    sha256: string;
    bytes: number;
    openclawVersion: string;
    buildId?: string;
    manifestSha256?: string;
    enabledPluginIds: readonly string[];
  };
  workerBundle: { localPath: string; sha256: string; bytes: number; packageRelativePath: string };
  target?: CrabboxOperatingSystem;
}): { command: string; forwardedEnv: Record<string, string> } {
  if (params.nodeBootstrap.install === "npm") {
    throw new Error("Offline runtime installation requires a preassembled bundle");
  }
  for (const artifact of [params.nodeBootstrap, params.workerBundle]) {
    if (
      !/^[a-f0-9]{64}$/u.test(artifact.sha256) ||
      !Number.isSafeInteger(artifact.bytes) ||
      artifact.bytes <= 0 ||
      !artifact.localPath
    ) {
      throw new Error("Offline runtime archive identity is invalid");
    }
  }
  return createCrabboxNodeSetup({ ...params, offline: true });
}

/** Verify an existing current cache without installation, publication or enrollment. */
export function createCrabboxRuntimeCacheVerification(
  params: CrabboxRuntimeInstallationIdentity & { target?: CrabboxOperatingSystem },
): { command: string; forwardedEnv: Record<string, string> } {
  for (const artifact of [params.nodeBootstrap, params.workerBundle]) {
    if (
      !/^[a-f0-9]{64}$/u.test(artifact.sha256) ||
      !Number.isSafeInteger(artifact.bytes) ||
      artifact.bytes <= 0
    ) {
      throw new Error("Runtime cache archive identity is invalid");
    }
  }
  return createCrabboxNodeSetup({ ...params, offline: true, verifyOnly: true });
}

function createCrabboxNodeSetup(
  params: {
    enrollment?: CrabboxWorkerNodeEnrollment;
    workerCodex?: CrabboxWorkerNodeEnrollment["workerCodex"];
    desktop?: boolean;
    desktopSetup?: string;
    target?: CrabboxOperatingSystem;
    verifyOnly?: boolean;
  } & (
    | {
        offline: true;
        leaseId?: never;
        nodeBootstrap: Omit<
          Parameters<typeof createCrabboxOfflineRuntimeSetup>[0]["nodeBootstrap"],
          "localPath"
        > & { localPath?: string };
        workerBundle: CrabboxRuntimeInstallationIdentity["workerBundle"] & { localPath?: string };
      }
    | {
        offline?: false;
        leaseId: string;
        nodeBootstrap: CrabboxWorkerNodeEnrollment["nodeBootstrap"];
        workerBundle?: CrabboxWorkerNodeRuntimePreparation["workerBundle"];
      }
  ),
): { command: string; forwardedEnv: Record<string, string> } {
  const { enrollment, leaseId, target = "linux" } = params;
  const { token, linuxToolchainSetup } = params.offline ? {} : params.nodeBootstrap;
  const nodeBootstrap = params.offline
    ? params.nodeBootstrap
    : (({ token: _token, linuxToolchainSetup: _setup, ...artifact }) => artifact)(
        params.nodeBootstrap,
      );
  const workerBundle =
    !params.offline && params.workerBundle
      ? (({ token: _token, ...artifact }) => artifact)(params.workerBundle)
      : params.workerBundle;
  const desktopTarget = params.desktop ? target : undefined;
  const desktopEnvironment =
    desktopTarget === "linux"
      ? [
          "set -eu",
          ...createCrabboxXfceSessionEnvironment(),
          `exec "$1" -e 'process.stdout.write(JSON.stringify({DISPLAY:process.env.DISPLAY,DBUS_SESSION_BUS_ADDRESS:process.env.DBUS_SESSION_BUS_ADDRESS,XDG_RUNTIME_DIR:process.env.XDG_RUNTIME_DIR}))'`,
        ].join("\n")
      : null;
  // The script receives credentials only through the private forwarded environment.
  // Its children inherit neither download authority nor the enrollment credential.
  const script = `const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const http = require("node:http");
const https = require("node:https");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const { performance } = require("node:perf_hooks");
const { setTimeout: delay } = require("node:timers/promises");
const bootstrap = ${JSON.stringify(nodeBootstrap)};
const workerBundle = ${JSON.stringify(workerBundle)};
const leaseId = ${JSON.stringify(leaseId)};
const displayName = ${JSON.stringify(enrollment?.displayName)};
const mode = ${JSON.stringify(enrollment?.mode)};
const desktopEnvironment = ${JSON.stringify(desktopEnvironment)};
const desktopSetup = ${JSON.stringify(params.desktopSetup)};
const credentials = ${params.offline ? "undefined" : `process.env.${CLOUD_BOOTSTRAP_TOKEN_ENV}`};
const setupCode = ${params.offline ? "undefined" : `process.env.${CLOUD_SETUP_CODE_ENV}`};
const workerCodexBase64 = ${params.offline ? "undefined" : `process.env.${CLOUD_WORKER_CODEX_ENV}`};
delete process.env.${CLOUD_BOOTSTRAP_TOKEN_ENV};
delete process.env.${CLOUD_SETUP_CODE_ENV};
delete process.env.${CLOUD_WORKER_CODEX_ENV};
if (process.platform !== "win32") process.umask(0o077);
let phase;
const bootstrapTimings = [];
let activationStarted;
const timed = async (name, work, overlapping = false) => {
  const started = performance.now();
  try { return await work(); }
  finally { bootstrapTimings.push({ name, ms: performance.now() - started, ...(overlapping ? { overlapping: true } : {}) }); }
};
const reportTiming = () => {
  if (activationStarted !== undefined) bootstrapTimings.push({ name: "bootstrap.activation", ms: performance.now() - activationStarted });
  // Fixed phase names and numeric observations only; never script output or authority.
  console.error(JSON.stringify({ runnerPhases: bootstrapTimings }));
};
const failureMessage = (artifact, failedPhase, code, origin) => "Cloud worker " + artifact + " " + failedPhase + " failed" + (code ? " (" + code + ")" : "") + (origin ? " from " + origin : "");
const setPhase = (next) => {
  if (phase === next) return;
  phase = next;
  console.error("CRABBOX_PHASE:openclaw-bootstrap-" + next.toLowerCase().replaceAll(" ", "-"));
};
setPhase("preparation");
(async () => {
  let tokens;
  try { tokens = JSON.parse(credentials || "{}"); }
  catch { throw new Error("Cloud worker bootstrap credential format is invalid"); }
  const home = fs.realpathSync(os.homedir());
  const stateDir = ${leaseId ? createCrabboxWorkerStateDirScript(leaseId) : "undefined"};
  const stageWorkerCodex = () => {
    if (!workerCodexBase64) return;
    let settings;
    try { settings = JSON.parse(Buffer.from(workerCodexBase64, "base64").toString("utf8")); }
    catch { throw new Error("Cloud worker Codex settings are invalid"); }
    const { configToml, helperScript, helperPath, configVersion } = settings;
    if (![configToml, helperScript, helperPath, configVersion].every((value) => typeof value === "string" && value.length > 0) || !/^[a-f0-9]{64}$/.test(configVersion)) throw new Error("Cloud worker Codex settings are incomplete");
    const helperName = path.basename(helperPath);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\\.mjs$/.test(helperName) || configToml.split(helperPath).length !== 2) throw new Error("Cloud worker Codex helper path is missing or ambiguous");
    const directory = path.join(stateDir, "codex-runtime");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(directory).isDirectory() || fs.realpathSync(directory) !== directory) throw new Error("Cloud worker Codex settings directory is unsafe");
    if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
    const versionFile = path.join(directory, "version");
    if (fs.existsSync(versionFile) && fs.readFileSync(versionFile, "utf8") !== configVersion) throw new Error("Cloud worker Codex version changed on an existing lease; reprovision the worker");
    const writePrivate = (name, content) => {
      const destination = path.join(directory, name);
      const temporary = destination + "." + crypto.randomUUID();
      try {
        fs.writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
        fs.renameSync(temporary, destination);
      } finally { fs.rmSync(temporary, { force: true }); }
    };
    writePrivate(helperName, helperScript);
    writePrivate("config.toml", configToml.replace(helperPath, path.join(directory, helperName)));
    writePrivate("version", configVersion);
  };
  const runtimeRoot = path.join(home, ".openclaw-worker", "node-runtimes");
  const runtimeDir = path.join(runtimeRoot, bootstrap.sha256);
  const cli = path.join(runtimeDir, "node_modules", "openclaw", "openclaw.mjs");
  const pidFile = stateDir && path.join(stateDir, "node.pid");
  const launchFile = stateDir && path.join(stateDir, "node-launch.json");
  const setupFile = stateDir && path.join(stateDir, "setup-code");
  const runtimeLink = stateDir && path.join(stateDir, "runtime");
  const nodeEnv = { ...process.env, ...(mode ? { OPENCLAW_STATE_DIR: stateDir } : {}) };
  // Tools travel inside the verified full-node artifact and share its preparation identity.
  if (process.platform !== "win32") {
    nodeEnv.PATH = (process.platform === "linux" ? path.dirname(process.execPath) + path.delimiter : "") + path.join(runtimeDir, "node_modules", "openclaw", "dist", "worker-tools", "bin") + path.delimiter + (nodeEnv.PATH || "");
  }
  const subprocessError = (message, result) => {
    let detail = [result.error?.message, result.stderr].filter(Boolean).join("\\n");
    // Sanitize complete values before truncation can leave an unrecognizable credential fragment.
    const privateValues = [credentials, setupCode, ...Object.values(tokens), ...Object.values(nodeEnv)]
      .filter((value) => typeof value === "string" && value.length > 0)
      .sort((a, b) => b.length - a.length);
    for (const value of privateValues) detail = detail.replaceAll(value, "[redacted]");
    detail = detail
      .replace(/\\b(?:Bearer|Basic)\\s+\\S+/gi, "[redacted]")
      .replace(/([A-Za-z_][A-Za-z0-9_]*\\s*=\\s*)(?:"[^"]*"|'[^']*'|[^\\s]+)/g, "$1[redacted]")
      .replace(/\\s+/g, " ").trim();
    const bytes = Buffer.from(detail);
    let start = Math.max(0, bytes.length - 512);
    while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
    const cause = new Error("exit code " + (result.status ?? "unknown") + ", signal " + (result.signal ?? "none") + (detail ? ": " + bytes.subarray(start).toString("utf8") : ""));
    return new Error(message + ": " + cause.message, { cause });
  };
  const finishDesktopSetup = () => {
    if (!desktopSetup) return;
    setPhase("desktop setup");
    // The wallpaper can exceed the OS argument limit; stream the owned script over stdin.
    if (process.platform === "win32") {
      runWindowsDesktopPowerShell(desktopSetup);
      return;
    }
    const result = spawnSync("bash", ["-s"], { input: desktopSetup, env: nodeEnv, stdio: ["pipe", "inherit", "inherit"], timeout: ${CRABBOX_SETUP_TIMEOUT_MS}, killSignal: "SIGKILL" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error("Cloud worker desktop setup failed" + (result.signal ? " (" + result.signal + ")" : " with exit code " + result.status));
  };
  const directoryOptions = process.platform === "win32" ? {} : { mode: 0o700 };
  // Forks of a warm image load disk blocks lazily on first read, so a cold node start
  // spends ~30 s on serial reads. A boot-time parallel read of the current runtime
  // overlaps that with SSH readiness. Best effort: images without cron keep the cold start.
  // Only a Crabbox run on this lease edits the crontab; local executions (tests) never do.
  const installRuntimePrefetch = () => {
    if (!leaseId || process.platform !== "linux" || process.env.CRABBOX_LEASE_ID !== leaseId) return;
    try {
      const script = path.join(runtimeRoot, ".prefetch.sh");
      const nodeDir = path.dirname(path.dirname(fs.realpathSync(process.execPath)));
      fs.writeFileSync(path.join(runtimeRoot, ".prefetch"), runtimeDir + "\\n" + nodeDir + "\\n");
      fs.writeFileSync(script, '#!/bin/sh\\ncd "$(dirname "$0")" || exit 0\\ndate +%s.%N > .prefetch.log\\nwhile IFS= read -r dir; do find "$dir" -type f -print0; done < .prefetch | xargs -0 -n 64 -P 64 cat > /dev/null 2>&1\\ndate +%s.%N >> .prefetch.log\\n', { mode: 0o700 });
      const current = spawnSync("crontab", ["-l"], { encoding: "utf8", timeout: 10000 });
      const kept = (current.status === 0 ? current.stdout : "").split("\\n").filter((line) => line && !line.includes(script));
      spawnSync("crontab", ["-"], { input: [...kept, "@reboot /bin/sh " + script].join("\\n") + "\\n", timeout: 10000 });
    } catch { /* Prefetch is optional; failed setup keeps the ordinary cold-start path. */ }
  };
  const launcher = path.join(process.env.ProgramFiles || "C:\\\\Program Files", "Crabbox", "bin", "Start-CrabboxDetachedProcess.ps1");
  if (process.platform === "win32" && mode && !${JSON.stringify(desktopTarget === "windows/normal")} && !fs.existsSync(launcher)) {
    throw new Error("Cloud worker requires " + launcher + "; update the Crabbox Windows bootstrap image and reprovision the worker");
  }
  if (desktopEnvironment) {
    // Inspect XFCE only after stripping forwarded credentials from every child environment.
    const desktop = spawnSync("bash", ["-c", desktopEnvironment, "bash", process.execPath], { env: nodeEnv, encoding: "utf8", timeout: 60000 });
    if (desktop.status !== 0) throw new Error(desktop.stderr?.trim() || "Cloud worker XFCE session is unavailable");
    delete nodeEnv.XDG_RUNTIME_DIR;
    Object.assign(nodeEnv, JSON.parse(desktop.stdout));
  }
  if (mode) {
    fs.mkdirSync(stateDir, { recursive: true, ...directoryOptions });
    if (process.platform !== "win32") fs.chmodSync(stateDir, 0o700);
    else if (path.dirname(stateDir) === path.join(path.parse(home).root, "ocw")) {
      // The drive root does not inherit the worker profile's private permissions.
      const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
      const secureState = "$ErrorActionPreference = 'Stop'; $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; icacls.exe " + quote(stateDir) + " /inheritance:r /grant:r ('*' + $sid + ':(OI)(CI)F') /grant:r '*S-1-5-18:(OI)(CI)F' /grant:r '*S-1-5-32-544:(OI)(CI)F' | Out-Null; exit $LASTEXITCODE";
      const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", secureState], { env: nodeEnv, encoding: "utf8", windowsHide: true, timeout: 10000 });
      if (result.error || result.status !== 0) throw subprocessError("Cloud worker state directory permissions could not be secured", result);
    }
    stageWorkerCodex();
  }
  ${params.offline ? "const desktopTarget = undefined;" : createCrabboxNodeProcessRuntime(desktopTarget, params.leaseId)}
  if (desktopTarget === "macos") finishDesktopSetup();
  ${CRABBOX_NPM_RUNTIME_INSTALL_SOURCE}
  ${CRABBOX_RUNTIME_VERIFICATION_SOURCE}
  const verifyRuntime = async (root, fresh = false) => {
    setPhase("runtime verification");
    if (!fs.lstatSync(root).isDirectory() || fs.realpathSync(root) !== root) throw new Error("Cloud worker bootstrap runtime path is unsafe");
    const packageRoot = path.join(root, "node_modules", "openclaw");
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    if (manifest.name !== "openclaw" || manifest.version !== bootstrap.openclawVersion) throw new Error("Cloud worker bootstrap package identity does not match the Gateway");
    const inventoryBytes = fs.readFileSync(path.join(packageRoot, "node-runtime.manifest.json"));
    if (!bootstrap.manifestSha256 || crypto.createHash("sha256").update(inventoryBytes).digest("hex") !== bootstrap.manifestSha256) throw new Error("Cloud worker runtime inventory does not match the Gateway");
    const metadataBytes = fs.readFileSync(path.join(packageRoot, "node-runtime.json"));
    const metadata = JSON.parse(metadataBytes);
    if (!bootstrap.buildId || metadata.buildId !== bootstrap.buildId || metadata.openclawVersion !== bootstrap.openclawVersion) throw new Error("Cloud worker runtime build identity does not match the Gateway");
    if ((metadata.install ?? "bundle") !== (bootstrap.install ?? "bundle")) throw new Error("Cloud worker runtime installation mode does not match the Gateway");
    if (bootstrap.install !== "npm") {
    const target = metadata.platforms.find((item) => item.platform === process.platform && item.arch === process.arch);
    if (!target) throw new Error("Cloud worker runtime has no prepared dependencies for " + process.platform + "/" + process.arch + "; prepare the matching runtime on the Gateway before provisioning");
    if (fresh && target.prefix) {
      fs.renameSync(path.join(packageRoot, "node_modules"), path.join(packageRoot, ".host-node_modules"));
      fs.renameSync(path.join(packageRoot, target.prefix, "node_modules"), path.join(packageRoot, "node_modules"));
    }
    }
    const probe = spawnSync(process.execPath, [path.join(packageRoot, "openclaw.mjs"), "--version"], { env: nodeEnv, encoding: "utf8", timeout: 60000 });
    const version = probe.stdout?.trim();
    const expected = "OpenClaw " + bootstrap.openclawVersion;
    if (probe.status !== 0 || (version !== expected && !version?.startsWith(expected + " "))) throw subprocessError("Cloud worker bootstrap CLI could not verify its Gateway version", probe);
  };
  const verifyArchive = async (source, artifact) => {
    const hash = crypto.createHash("sha256");
    let bytes = 0;
    for await (const chunk of source) {
      bytes += chunk.byteLength;
      if (bytes > artifact.bytes) throw new Error("Cloud worker bootstrap archive exceeds its declared size");
      hash.update(chunk);
    }
    if (bytes !== artifact.bytes || hash.digest("hex") !== artifact.sha256) throw new Error("Cloud worker bootstrap archive failed integrity verification");
  };
  const downloadAbort = new AbortController();
  const downloadAttempt = async (artifact, token, archive, offset, reportPhase) => {
    reportPhase("download connection");
    // A reset after the final bytes needs verification, not an unsatisfiable range.
    if (offset >= artifact.bytes) {
      await verifyArchive(fs.createReadStream(archive), artifact);
      return;
    }
    if (!token) throw new Error("Cloud worker bootstrap download authority is unavailable");
    const url = new URL(artifact.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || (artifact.tlsFingerprint && url.protocol !== "https:")) throw new Error("Cloud worker bootstrap artifact transport is invalid");
    const normalizePin = (value) => value.trim().replace(/^sha256:/i, "").replaceAll(":", "").toLowerCase();
    const pin = artifact.tlsFingerprint ? normalizePin(artifact.tlsFingerprint) : undefined;
    if (pin && !/^[a-f0-9]{64}$/.test(pin)) throw new Error("Cloud worker bootstrap TLS fingerprint is invalid");
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(url, {
      agent: false, headers: { authorization: "Bearer " + token, ...(offset ? { range: "bytes=" + offset + "-" } : {}) }, signal: downloadAbort.signal,
      ...(pin ? { rejectUnauthorized: false, session: Buffer.alloc(0) } : {}),
    });
    // The response/body readers still reject; keep errors observed between their awaits.
    request.on("error", () => {});
    request.once("response", (response) => response.on("error", () => {}));
    // Observe transport progress without changing when the pinned request may send credentials.
    request.once("socket", (socket) => {
      socket.setTimeout(${CLOUD_BOOTSTRAP_DOWNLOAD_IDLE_TIMEOUT_MS}, () => request.destroy(Object.assign(new Error("Cloud worker bootstrap download stalled"), { code: "ETIMEDOUT" })));
      socket.once("connect", () => { reportPhase(url.protocol === "https:" ? "download TLS" : "download HTTP response"); });
      socket.once("secureConnect", () => { if (!pin) reportPhase("download HTTP response"); });
    });
    const pendingResponse = once(request, "response").then(([response]) => response);
    // Pinned private certificates authenticate the socket before any bearer bytes leave.
    void (async () => {
      if (pin) {
        const [socket] = await once(request, "socket");
        await once(socket, "secureConnect");
        if (normalizePin(socket.getPeerCertificate().fingerprint256 ?? "") !== pin) throw new Error("Cloud worker bootstrap TLS fingerprint mismatch");
        reportPhase("download HTTP response");
      }
      request.end();
    })().catch((error) => request.destroy(error));
    const response = await pendingResponse;
    try {
      if (response.statusCode === 416 && offset) {
        fs.rmSync(archive, { force: true });
        throw Object.assign(new Error("Cloud worker bootstrap resume range was rejected"), { code: "ARTIFACT_RANGE_MISMATCH" });
      }
      if (response.statusCode !== 200 && response.statusCode !== 206) {
        const error = Object.assign(new Error("Cloud worker bootstrap download failed with HTTP " + response.statusCode), { statusCode: response.statusCode });
        if (response.statusCode === 503) {
          let body = "";
          for await (const chunk of response) {
            if (Buffer.byteLength(body) + chunk.byteLength > 1024) { body = ""; break; }
            body += chunk.toString("utf8");
          }
          try { if (JSON.parse(body)?.error === "transfer_in_progress") error.code = "TRANSFER_IN_PROGRESS"; }
          catch { /* Other proxy responses remain ordinary HTTP failures. */ }
        }
        throw error;
      }
      if (response.statusCode === 200) {
        // An older Gateway or proxy may ignore Range; never append its full response.
        fs.rmSync(archive, { force: true });
        offset = 0;
      } else if (response.headers["content-range"] !== "bytes " + offset + "-" + (artifact.bytes - 1) + "/" + artifact.bytes) {
        fs.rmSync(archive, { force: true });
        throw Object.assign(new Error("Cloud worker bootstrap resume range does not match the Gateway"), { code: "ARTIFACT_RANGE_MISMATCH" });
      }
      if (response.headers["content-length"] !== undefined && Number(response.headers["content-length"]) !== artifact.bytes - offset) {
        fs.rmSync(archive, { force: true });
        throw Object.assign(new Error("Cloud worker bootstrap archive length does not match the Gateway"), response.statusCode === 206 ? { code: "ARTIFACT_RANGE_MISMATCH" } : {});
      }
      reportPhase("download body");
      const output = await fsp.open(archive, offset ? "a" : "wx", 0o600);
      try {
        for await (const chunk of response) {
          offset += chunk.byteLength;
          if (offset > artifact.bytes) throw new Error("Cloud worker bootstrap archive exceeds its declared size");
          await output.writeFile(chunk);
        }
      }
      finally { await output.close(); }
      await verifyArchive(fs.createReadStream(archive), artifact);
    } finally { response.destroy(); }
  };
  const downloadArchive = async (artifact, token, archive, reportPhase = setPhase) => {
    let downloadPhase;
    let origin;
    const downloadArtifact = artifact === workerBundle ? "archive" : "node bootstrap";
    const progress = (next) => { downloadPhase = next; reportPhase(next); };
    let attempt = 1;
    let retries = 0;
    let noProgressFailures = 0;
    // A fresh no-progress streak waits about 24-40 seconds through edge reconnects.
    const maxNoProgressFailures = 9;
    let offset = 0;
    let retainedAnyBytes = false;
    const partial = archive + ".partial";
    try {
      if (artifact.localPath !== undefined) {
        reportPhase("local archive verification");
        if (!path.isAbsolute(artifact.localPath)) throw new Error("Cloud worker local archive path is invalid");
        const source = await fsp.open(artifact.localPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        try {
          const stat = await source.stat();
          if (!stat.isFile() || stat.nlink !== 1 || stat.size !== artifact.bytes || fs.realpathSync(artifact.localPath) !== artifact.localPath || (process.platform !== "win32" && stat.uid !== process.getuid())) throw new Error("Cloud worker local archive path, owner or length is unsafe");
          const output = await fsp.open(partial, "wx", 0o600);
          const input = source.createReadStream({ autoClose: false });
          try {
            let bytes = 0;
            for await (const chunk of input) {
              bytes += chunk.byteLength;
              if (bytes > artifact.bytes) throw new Error("Cloud worker bootstrap archive exceeds its declared size");
              await output.writeFile(chunk);
            }
          } finally { input.destroy(); await output.close(); }
        } finally { await source.close(); }
        await verifyArchive(fs.createReadStream(partial), artifact);
        fs.renameSync(partial, archive);
        return;
      }
      origin = new URL(artifact.url).origin;
      for (;;) {
        try {
          if (retries > 0) await delay(Math.round(250 * 2 ** Math.min(retries - 1, 5) * (0.75 + Math.random() * 0.5)), undefined, { signal: downloadAbort.signal });
          downloadAbort.signal.throwIfAborted();
          await downloadAttempt(artifact, token, partial, offset, progress);
          fs.renameSync(partial, archive);
          return;
        } catch (error) {
          if (downloadAbort.signal.aborted) throw downloadAbort.signal.reason;
          const busy = error.code === "TRANSFER_IN_PROGRESS";
          const transient = busy || ["ARTIFACT_RANGE_MISMATCH", "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ENETUNREACH", "EHOSTUNREACH", "ENETDOWN", "EPIPE", "ERR_STREAM_PREMATURE_CLOSE", "ABORT_ERR", "ETIMEDOUT", "ESOCKETTIMEDOUT", "EAI_AGAIN"].includes(error.code) || [502, 503, 504, 520, 521, 522, 523, 524, 530].includes(error.statusCode);
          if (transient && !busy) {
            let retainedBytes = 0;
            try { retainedBytes = (await fsp.stat(partial)).size; }
            catch (statError) { if (statError.code !== "ENOENT") throw statError; }
            // Count retained progress, not bytes replayed by a proxy that ignores Range.
            noProgressFailures = retainedBytes > offset ? 0 : noProgressFailures + 1;
            offset = retainedBytes;
            retainedAnyBytes ||= retainedBytes > 0;
          }
          if (!transient || noProgressFailures === maxNoProgressFailures) {
            const hint = !retainedAnyBytes && ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN"].includes(error.code)
              ? " The worker could not reach the Gateway public origin <" + origin + ">; verify the provider's network can reach it (for example with curl from a sandbox) or configure gateway.publicOrigin on a reachable hostname."
              : "";
            throw Object.assign(new Error(error.message + " (download attempt " + attempt + (noProgressFailures === maxNoProgressFailures ? "; " + maxNoProgressFailures + " consecutive no-progress failures" : "") + ")" + hint, { cause: error }), { code: error.code });
          }
          if (!busy) attempt++;
          retries++;
          console.error(failureMessage("bootstrap", downloadPhase, error.code || "HTTP_" + error.statusCode, origin) + "; retrying download attempt " + attempt + " (" + noProgressFailures + "/" + maxNoProgressFailures + " consecutive no-progress failures)");
        }
      }
    } catch (error) {
      if (!downloadAbort.signal.aborted) {
        downloadAbort.abort(Object.assign(new Error(failureMessage(downloadArtifact, downloadPhase || phase, error.code, origin) + ": " + error.message, { cause: error }), { code: error.code, downloadPhase, downloadArtifact }));
      }
      throw downloadAbort.signal.reason;
    } finally { fs.rmSync(partial, { force: true }); }
  };
  const workerArchivePath = (root) => {
    const relative = workerBundle.packageRelativePath;
    const parts = relative.split("/");
    if (parts.length !== 2 || !/^[a-z][a-z-]*$/.test(parts[0]) || parts[1] !== workerBundle.sha256 + ".tgz" || !/^[a-f0-9]{64}$/.test(workerBundle.sha256)) throw new Error("Cloud worker archive package path is invalid");
    return path.join(root, "node_modules", "openclaw", ...parts);
  };
  const verifyWorkerArchive = async (root) => {
    setPhase("worker archive verification");
    const archive = workerArchivePath(root);
    let handle;
    // A non-regular artifact (including a FIFO) must reject without blocking preparation.
    try { handle = await fsp.open(archive, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== workerBundle.bytes || fs.realpathSync(archive) !== archive) throw new Error("Cloud worker prepared archive path or length is unsafe");
      const source = handle.createReadStream({ autoClose: false });
      try { await verifyArchive(source, workerBundle); }
      finally { source.destroy(); }
    } finally { await handle.close(); }
    return true;
  };
  const publishWorkerArchive = (root, downloaded) => {
    if (!workerBundle) return;
    setPhase("worker archive publication");
    const archive = workerArchivePath(root);
    const directory = path.dirname(archive);
    fs.mkdirSync(directory, { recursive: true, ...directoryOptions });
    if (fs.realpathSync(directory) !== directory || !fs.lstatSync(directory).isDirectory()) throw new Error("Cloud worker prepared archive directory is unsafe");
    if (downloaded) fs.renameSync(downloaded, archive);
    // This package owns one immutable source archive; ordinary node installs never write here.
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name !== path.basename(archive) && /^[a-f0-9]{64}\\.tgz$/.test(entry.name)) {
        if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Cloud worker prepared archive directory contains an unsafe artifact");
        fs.unlinkSync(path.join(directory, entry.name));
      }
    }
  };
  // Verification never repairs a cache, prunes older archives or binds runtime Node.
  if (${Boolean(params.verifyOnly)}) {
    await timed("bootstrap.verification", () => verifyRuntime(runtimeDir));
    if (!await timed("bootstrap.worker.verification", () => verifyWorkerArchive(runtimeDir))) throw new Error("Cloud worker prepared archive is missing");
    reportRuntimeInstallation("existing-verified");
    setPhase("complete");
    return;
  }
  const prepareRuntime = async () => {
  fs.mkdirSync(runtimeRoot, { recursive: true, ...directoryOptions });
  const existingRuntime = fs.existsSync(runtimeDir);
  if (existingRuntime) await timed("bootstrap.verification", () => verifyRuntime(runtimeDir));
  if (existingRuntime && (!workerBundle || await timed("bootstrap.worker.verification", () => verifyWorkerArchive(runtimeDir)))) {
    publishWorkerArchive(runtimeDir);
  } else {
  const stage = fs.mkdtempSync(path.join(runtimeRoot, "node-bootstrap-"));
  try {
    const archive = path.join(stage, "openclaw.tgz");
    const downloadedWorker = workerBundle ? path.join(stage, "worker.tgz") : undefined;
    const installDir = existingRuntime ? runtimeDir : path.join(stage, "runtime");
    const overlap = downloadedWorker && !existingRuntime;
    // Both capabilities expire from issuance; installation must not wait for the worker archive.
    await Promise.allSettled([
      (async () => {
        if (existingRuntime) return;
        await timed("bootstrap.runtime.transfer", () => downloadArchive(bootstrap, tokens.nodeBootstrap, archive), Boolean(overlap));
        downloadAbort.signal.throwIfAborted();
        setPhase(overlap ? "installation and worker download" : "installation");
        fs.mkdirSync(installDir, directoryOptions);
        if (bootstrap.install === "npm") {
          await installCrabboxNpmRuntime({ archive, installDir, stage, nodeEnv, downloadAbort });
        } else {
        const packageRoot = path.join(installDir, "node_modules", "openclaw");
        fs.mkdirSync(packageRoot, { recursive: true, ...directoryOptions });
        const runTar = (args) => new Promise((resolve, reject) => {
          const child = spawn(process.platform === "win32" ? "tar.exe" : "tar", args, { env: nodeEnv, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
          const output = []; let bytes = 0; let failure;
          const kill = () => {
            if (!child.pid) return;
            try {
              if (process.platform === "win32") {
                const result = spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { env: nodeEnv, windowsHide: true, stdio: "ignore", timeout: 10000 });
                if (result.error) failure ||= result.error;
              }
              else process.kill(-child.pid, "SIGKILL");
            } catch (error) { if (error.code !== "ESRCH") failure ||= error; }
          };
          const stop = () => { failure ||= downloadAbort.signal.reason; kill(); };
          const cancel = () => downloadAbort.abort(new Error("Cloud worker runtime extraction cancelled"));
          const timeout = setTimeout(() => { failure = new Error("Cloud worker runtime extraction timed out"); kill(); }, 600000);
          process.once("SIGTERM", cancel); process.once("SIGINT", cancel);
          downloadAbort.signal.addEventListener("abort", stop, { once: true });
          child.stdout.on("data", (chunk) => {
            bytes += chunk.length;
            if (bytes > 32 * 1024 * 1024) { failure = new Error("Cloud worker runtime archive listing exceeds its limit"); kill(); }
            else output.push(chunk);
          });
          child.stderr.resume();
          child.once("error", (error) => { failure = error; });
          child.once("close", (status) => {
            clearTimeout(timeout); process.removeListener("SIGTERM", cancel); process.removeListener("SIGINT", cancel);
            downloadAbort.signal.removeEventListener("abort", stop);
            if (failure || status !== 0) reject(failure || new Error("Cloud worker runtime archive extraction failed; verify tar is available in the image"));
            else resolve(Buffer.concat(output).toString("utf8"));
          });
          if (downloadAbort.signal.aborted) stop();
        });
        // Only regular producer-owned files/directories enter the private staging tree.
        // Listing before extraction prevents tar from following archive links or escaping package/.
        await timed("bootstrap.extraction", async () => {
        const names = (await runTar(["-tzf", archive])).trimEnd().split("\\n");
        const seen = new Set();
        if (names.length > 250000) throw new Error("Cloud worker runtime archive exceeds its entry limit");
        for (const name of names) {
          const relative = name.endsWith("/") ? name.slice(0, -1) : name;
          if (seen.has(relative) || relative.includes("\\\\") || path.posix.normalize(relative) !== relative || (relative !== "package" && !relative.startsWith("package/")) || relative.split("/").some((part) => !part || part === ".." || part === ".")) throw new Error("Cloud worker runtime archive path is unsafe");
          seen.add(relative);
        }
        const types = (await runTar(["-tvzf", archive])).trimEnd().split("\\n");
        if (types.some((entry) => !["-", "d"].includes(entry[0]))) throw new Error("Cloud worker runtime archive contains an unsafe entry type");
        await runTar(["-xzf", archive, "--strip-components=1", "--no-same-owner", "--no-same-permissions", "-C", packageRoot]);
        }, Boolean(overlap));
        }
        downloadAbort.signal.throwIfAborted();
        await timed("bootstrap.verification", () => verifyRuntime(installDir, true), Boolean(overlap));
      })().catch((error) => {
        if (!downloadAbort.signal.aborted) downloadAbort.abort(Object.assign(error, { downloadPhase: phase }));
        throw downloadAbort.signal.reason;
      }),
      // The runtime branch owns the overlap marker; downloadArchive retains the worker's error phase.
      downloadedWorker ? timed("bootstrap.worker.transfer", () => downloadArchive(workerBundle, tokens.workerBundle, downloadedWorker, overlap ? () => {} : setPhase), Boolean(overlap)) : undefined,
    ]);
    // Every started extraction/download child settles before staging can be removed.
    if (downloadAbort.signal.aborted) throw downloadAbort.signal.reason;
    publishWorkerArchive(installDir, downloadedWorker);
    // Archive publication completes before a fresh runtime becomes reusable or capture can begin.
    if (!existingRuntime) fs.renameSync(installDir, runtimeDir);
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  }
  installRuntimePrefetch();
  if (!mode && workerBundle) reportRuntimeInstallation(existingRuntime ? "existing-verified" : "installed");
  };
  if (mode && await reuseNodeProcess(prepareRuntime)) {
    if (desktopTarget !== "macos") finishDesktopSetup();
    setPhase("complete"); return;
  }
  if (!mode) {
    await prepareRuntime();
    setPhase("complete"); return;
  }
  activationStarted = performance.now();
  setPhase("activation");
  try {
    if (!fs.lstatSync(runtimeLink).isSymbolicLink()) throw new Error("Cloud worker runtime pointer is occupied");
    fs.unlinkSync(runtimeLink);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  setPhase("plugin activation");
  const pluginIds = [...new Set([...bootstrap.enabledPluginIds, ...${JSON.stringify(params.desktop ? ["cua-computer"] : [])}])];
  if (pluginIds.length > 0) {
    // One CLI process retains the combined per-plugin time and output allowances.
    const enabled = spawnSync(process.execPath, [cli, "plugins", "enable", ...pluginIds], { env: nodeEnv, encoding: "utf8", timeout: 60000 * pluginIds.length, maxBuffer: 1024 * 1024 * pluginIds.length });
    if (enabled.status !== 0) throw subprocessError("Cloud worker bootstrap could not enable plugins " + pluginIds.join(", "), enabled);
  }
  // Publishing this pointer earlier makes fresh state look like a legacy installation.
  fs.symlinkSync(runtimeDir, runtimeLink, process.platform === "win32" ? "junction" : "dir");
  if (mode === "connect") {
    if (!setupCode) throw new Error("Cloud worker enrollment credential is unavailable");
    fs.writeFileSync(setupFile, setupCode + "\\n", { mode: 0o600 });
  }
  await launchNodeProcess();
  if (desktopTarget !== "macos") finishDesktopSetup();
  setPhase("complete");
})().then(() => { reportTiming(); }, (error) => { reportTiming(); console.error(error.downloadArtifact ? error.message : failureMessage("node bootstrap", error.downloadPhase || phase, error.code) + ": " + error.message); process.exitCode = 1; });
`;
  return {
    command:
      (enrollment && target === "linux" ? CRABBOX_LINUX_PLATFORM_TRUST_SETUP : "") +
      (target === "linux" ? (linuxToolchainSetup ?? "") : "") +
      wrapCrabboxNodeScript(
        script.trimEnd(),
        target,
        "CRABBOX_NODE_ENROLLMENT_SCRIPT",
        params.verifyOnly ? "runtime" : "bootstrap",
      ),
    forwardedEnv: params.offline
      ? {}
      : {
          [CLOUD_BOOTSTRAP_TOKEN_ENV]: JSON.stringify({
            nodeBootstrap: token,
            workerBundle: params.workerBundle?.token,
          }),
          ...(enrollment?.mode === "connect"
            ? { [CLOUD_SETUP_CODE_ENV]: enrollment.setupCode }
            : {}),
          ...(params.workerCodex
            ? {
                [CLOUD_WORKER_CODEX_ENV]: Buffer.from(
                  JSON.stringify(params.workerCodex),
                  "utf8",
                ).toString("base64"),
              }
            : {}),
        },
  };
}
