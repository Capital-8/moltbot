import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { openFixtureReceiptChannel } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createCrabboxOfflineRuntimeSetup,
  createCrabboxRuntimeCacheVerification,
  parseCrabboxRuntimeInstallation,
  readCrabboxRuntimeInstallation,
} from "../cli-runtime-api.js";
import * as processRunner from "./crabbox-process.js";
import { prepareCrabboxAzureSnapshotCapture } from "./crabbox-worker-azure-snapshot-capture.js";
import {
  createNodePackageFixture,
  runtimeManifestSha256,
} from "./crabbox-worker-node-enrollment.test-support.js";
import { resolveCrabboxProvisionProfile } from "./crabbox-worker-profile.js";
import { commandResult } from "./crabbox-worker-provider.test-support.js";
import type { CrabboxSnapshotVerifierInput } from "./crabbox-worker-snapshot-verifier.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
const run = promisify(execFile);
let receipts: Awaited<ReturnType<typeof openFixtureReceiptChannel>>;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(() => receipts.close());

async function fixture() {
  const home = fs.realpathSync(tempDirs.make("offline-runtime-home-"));
  const source = fs.realpathSync(tempDirs.make("offline-runtime-archives-"));
  const archive = (name: string, bytes: Buffer) => {
    const localPath = path.join(source, name);
    fs.writeFileSync(localPath, bytes);
    return {
      localPath,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  };
  const nodeBootstrap = {
    ...archive(
      "node.tgz",
      await createNodePackageFixture(
        (prefix) => tempDirs.make(prefix),
        "offline-runtime",
        receipts,
      ),
    ),
    openclawVersion: "2026.8.1",
    buildId: "fixture-runtime-build",
    enabledPluginIds: ["demo"],
  };
  const manifestSha256 = await runtimeManifestSha256(fs.readFileSync(nodeBootstrap.localPath));
  if (!manifestSha256) {
    throw new Error("Offline runtime fixture requires its canonical inventory");
  }
  Object.assign(nodeBootstrap, { manifestSha256 });
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  fs.symlinkSync("/usr/bin/tar", path.join(bin, "tar"));
  const workerBytes = Buffer.from("synthetic portable worker archive");
  const worker = archive("worker.tgz", workerBytes);
  const workerBundle = { ...worker, packageRelativePath: `worker-artifacts/${worker.sha256}.tgz` };
  const setup = await createCrabboxOfflineRuntimeSetup({
    nodeBootstrap,
    workerBundle,
    target: "linux",
  });
  const env = {
    HOME: home,
    PATH: bin,
    npm_config_registry: "http://127.0.0.1:9/unreachable-registry",
    NPM_CONFIG_IGNORE_SCRIPTS: "true",
    CRABBOX_WORKER_BOOTSTRAP_TOKEN: "synthetic-inherited-credential",
    CRABBOX_WORKER_SETUP_CODE: "synthetic-inherited-enrollment",
  };
  const execute = () => run("/bin/sh", ["-c", setup.command], { env, timeout: 30_000 });
  const identity = {
    nodeBootstrap: {
      sha256: nodeBootstrap.sha256,
      bytes: nodeBootstrap.bytes,
      manifestSha256,
      buildId: nodeBootstrap.buildId,
      openclawVersion: nodeBootstrap.openclawVersion,
      enabledPluginIds: nodeBootstrap.enabledPluginIds,
    },
    workerBundle: {
      sha256: workerBundle.sha256,
      bytes: workerBundle.bytes,
      packageRelativePath: workerBundle.packageRelativePath,
    },
  };
  const verify = async (expected = identity) => {
    const verification = await createCrabboxRuntimeCacheVerification({
      ...expected,
      target: "linux",
    });
    expect(verification.forwardedEnv).toEqual({});
    return run("/bin/sh", ["-c", verification.command], { env, timeout: 30_000 });
  };
  const runtimeRoot = path.join(home, ".openclaw-worker", "node-runtimes");
  const runtime = path.join(runtimeRoot, nodeBootstrap.sha256);
  const packageRoot = path.join(runtime, "node_modules", "openclaw");
  return {
    home,
    manifestSha256,
    nodeBootstrap,
    workerBundle,
    workerBytes,
    setup,
    execute,
    env,
    identity,
    verify,
    runtimeRoot,
    runtime,
    packageRoot,
  };
}

describe.skipIf(process.platform === "win32")("offline runtime cache installation", () => {
  it("verifies the current cache independently of baked archives without changing cache contents", async () => {
    const f = await fixture();
    await f.execute();
    // The image's older runtime/archive is neither the selected current identity nor repair input.
    const baked = path.join(f.runtimeRoot, "c".repeat(64));
    fs.mkdirSync(baked);
    const oldArchive = path.join(f.packageRoot, "worker-artifacts", "d".repeat(64) + ".tgz");
    fs.writeFileSync(oldArchive, "old baked archive");
    fs.unlinkSync(f.nodeBootstrap.localPath);
    fs.unlinkSync(f.workerBundle.localPath);
    const nodeBinding = path.join(f.home, ".openclaw-worker", "runtime-node");
    fs.rmSync(nodeBinding, { recursive: true });
    const inode = fs.statSync(f.runtime).ino;
    const verified = await f.verify();
    expect(readCrabboxRuntimeInstallation(verified.stdout, f.identity).disposition).toBe(
      "existing-verified",
    );
    expect(fs.statSync(f.runtime).ino).toBe(inode);
    expect(fs.readdirSync(f.runtimeRoot).toSorted()).toEqual(
      [f.nodeBootstrap.sha256, "c".repeat(64)].toSorted(),
    );
    expect(fs.readFileSync(oldArchive, "utf8")).toBe("old baked archive");
    expect(fs.existsSync(nodeBinding)).toBe(false);
    expect(fs.existsSync(path.join(f.home, ".openclaw"))).toBe(false);
  });

  it.each([
    "runtime-missing",
    "manifest-missing",
    "manifest-corrupt",
    "archive-missing",
    "archive-corrupt",
    "build",
    "version",
    "mode",
    "platform",
    "runtime-symlink",
  ] as const)("refuses %s without installation, replacement or enrollment", async (failure) => {
    const f = await fixture();
    if (failure !== "runtime-missing") {
      await f.execute();
      const manifest = path.join(f.packageRoot, "node-runtime.manifest.json");
      const archive = path.join(f.packageRoot, f.workerBundle.packageRelativePath);
      if (failure === "manifest-missing") {
        fs.unlinkSync(manifest);
      }
      if (failure === "manifest-corrupt") {
        fs.appendFileSync(manifest, " ");
      }
      if (failure === "archive-missing") {
        fs.unlinkSync(archive);
      }
      if (failure === "archive-corrupt") {
        fs.writeFileSync(archive, Buffer.alloc(f.workerBytes.length));
      }
      if (["build", "version", "mode", "platform"].includes(failure)) {
        const metadata = path.join(f.packageRoot, "node-runtime.json");
        const value = JSON.parse(fs.readFileSync(metadata, "utf8"));
        if (failure === "build") {
          value.buildId = "other-build";
        }
        if (failure === "version") {
          value.openclawVersion = "0.0.0";
        }
        if (failure === "mode") {
          value.install = "npm";
        }
        if (failure === "platform") {
          value.platforms = [];
        }
        fs.writeFileSync(metadata, JSON.stringify(value));
      }
      if (failure === "runtime-symlink") {
        fs.renameSync(f.runtime, f.runtime + "-elsewhere");
        fs.symlinkSync(f.runtime + "-elsewhere", f.runtime);
      }
    }
    // Original archives remain available: verification must not consume them to repair a miss.
    const cache = path.join(f.home, ".openclaw-worker");
    const cacheEntries = () =>
      fs.existsSync(cache)
        ? fs
            .readdirSync(cache, { recursive: true, encoding: "utf8" })
            .toSorted((a, b) => a.localeCompare(b))
        : null;
    const before = cacheEntries();
    const runtimeStat = fs.lstatSync(f.runtime, { throwIfNoEntry: false });
    const diagnostic = {
      "runtime-missing": "ENOENT",
      "manifest-missing": "ENOENT",
      "manifest-corrupt": "inventory does not match",
      "archive-missing": "prepared archive is missing",
      "archive-corrupt": "integrity verification",
      build: "build identity does not match",
      version: "build identity does not match",
      mode: "installation mode does not match",
      platform: "no prepared dependencies",
      "runtime-symlink": "runtime path is unsafe",
    };
    await expect(f.verify()).rejects.toMatchObject({
      code: 1,
      stdout: "",
      stderr: expect.stringContaining(diagnostic[failure]),
    });
    expect(cacheEntries()).toEqual(before);
    expect(fs.lstatSync(f.runtime, { throwIfNoEntry: false })?.ino).toBe(runtimeStat?.ino);
    expect(fs.existsSync(path.join(f.home, ".openclaw"))).toBe(false);
  });

  it("rejects a registry-backed node runtime at the explicit offline boundary", async () => {
    const f = await fixture();
    await expect(
      createCrabboxOfflineRuntimeSetup({
        nodeBootstrap: { ...f.nodeBootstrap, install: "npm" },
        workerBundle: f.workerBundle,
        target: "linux",
      }),
    ).rejects.toThrow("requires a preassembled bundle");
    expect(fs.existsSync(f.runtimeRoot)).toBe(false);
  });

  it("installs and reuses a complete runtime with npm absent and registry unreachable", async () => {
    const f = await fixture();
    expect(f.setup.forwardedEnv).toEqual({});
    const installed = await f.execute();
    const expected = {
      nodeBootstrap: {
        sha256: f.nodeBootstrap.sha256,
        bytes: f.nodeBootstrap.bytes,
        manifestSha256: f.manifestSha256,
        buildId: f.nodeBootstrap.buildId,
        openclawVersion: f.nodeBootstrap.openclawVersion,
        enabledPluginIds: f.nodeBootstrap.enabledPluginIds,
      },
      workerBundle: {
        sha256: f.workerBundle.sha256,
        bytes: f.workerBundle.bytes,
        packageRelativePath: f.workerBundle.packageRelativePath,
      },
    };
    const fact = readCrabboxRuntimeInstallation(installed.stdout, expected);
    expect(fact.disposition).toBe("installed");
    expect(fact.installationVerified).toBe(true);
    expect(fact).not.toHaveProperty("cacheHitVerified");
    // The existing image manifest can carry this fact between Docker RUN and verification.
    const manifestBytes = JSON.stringify({ installationVerification: fact });
    const restored: { installationVerification: unknown } = JSON.parse(manifestBytes);
    expect(parseCrabboxRuntimeInstallation(restored.installationVerification, expected)).toEqual(
      fact,
    );
    for (const output of ["", installed.stdout + installed.stdout]) {
      expect(() => readCrabboxRuntimeInstallation(output, expected)).toThrow();
    }
    for (const changed of [
      { ...fact, installationVerified: false },
      { ...fact, disposition: "cache-hit" },
      { ...fact, nodeBootstrap: { ...fact.nodeBootstrap, sha256: "f".repeat(64) } },
      { ...fact, nodeBootstrap: { ...fact.nodeBootstrap, enabledPluginIds: [] } },
      { ...fact, workerBundle: { ...fact.workerBundle, bytes: fact.workerBundle.bytes + 1 } },
    ]) {
      expect(() => parseCrabboxRuntimeInstallation(changed, expected)).toThrow();
    }
    const observations = installed.stderr
      .split("\n")
      .filter((line) => line.startsWith('{"runnerPhases":'));
    expect(observations).toHaveLength(1);
    const timing = JSON.parse(observations[0]!) as {
      runnerPhases: Array<{ name: string; ms: number; overlapping: boolean }>;
    };
    expect(timing.runnerPhases.map((phase) => phase.name).toSorted()).toEqual([
      "bootstrap.extraction",
      "bootstrap.runtime.transfer",
      "bootstrap.verification",
      "bootstrap.worker.transfer",
    ]);
    for (const phase of timing.runnerPhases) {
      expect(phase.ms).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(phase.ms)).toBe(true);
      expect(phase.overlapping).toBe(true);
      expect(Object.keys(phase).toSorted()).toEqual(["ms", "name", "overlapping"]);
    }
    expect(fs.existsSync(path.join(f.packageRoot, "installed.json"))).toBe(false);
    expect(fs.readFileSync(path.join(f.packageRoot, f.workerBundle.packageRelativePath))).toEqual(
      f.workerBytes,
    );
    expect(fs.existsSync(path.join(f.home, ".openclaw"))).toBe(false);
    expect(fs.readdirSync(f.runtimeRoot)).toEqual([f.nodeBootstrap.sha256]);
    expect(fs.statSync(f.runtime).mode & 0o777).toBe(0o700);
    const inode = fs.statSync(f.runtime).ino;
    fs.unlinkSync(f.nodeBootstrap.localPath);
    fs.unlinkSync(f.workerBundle.localPath);
    const reused = await f.execute();
    expect(readCrabboxRuntimeInstallation(reused.stdout, expected).disposition).toBe(
      "existing-verified",
    );
    expect(fs.statSync(f.runtime).ino).toBe(inode);
    expect(fs.existsSync(path.join(f.home, ".openclaw"))).toBe(false);
  }, 30_000);

  it.each(["digest", "symlink", "length"] as const)(
    "rejects unsafe local %s before cache publication",
    async (failure) => {
      const f = await fixture();
      if (failure === "symlink") {
        fs.renameSync(f.workerBundle.localPath, f.workerBundle.localPath + ".real");
        fs.symlinkSync(f.workerBundle.localPath + ".real", f.workerBundle.localPath);
      } else {
        fs.writeFileSync(
          f.workerBundle.localPath,
          failure === "digest" ? Buffer.alloc(f.workerBytes.length) : Buffer.alloc(1),
        );
      }
      await expect(f.execute()).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringMatching(
          failure === "digest"
            ? /integrity verification/
            : failure === "length"
              ? /length is unsafe/
              : /ELOOP/,
        ),
      });
      expect(fs.readdirSync(f.runtimeRoot)).toEqual([]);
      expect(fs.existsSync(path.join(f.home, ".openclaw"))).toBe(false);
    },
    30_000,
  );

  it("fails closed on incomplete cached runtime instead of enrolling or replacing it", async () => {
    const f = await fixture();
    await f.execute();
    const cli = path.join(f.packageRoot, "openclaw.mjs");
    fs.unlinkSync(cli);
    await expect(f.execute()).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("bootstrap CLI could not verify its Gateway version"),
    });
    expect(fs.existsSync(cli)).toBe(false);
    expect(fs.readdirSync(f.runtimeRoot)).toEqual([f.nodeBootstrap.sha256]);
    expect(fs.existsSync(path.join(f.home, ".openclaw"))).toBe(false);
  }, 30_000);
});

it
  .skipIf(process.platform === "win32")
  .each([
    "current",
    "missing-current",
    "receipt-identity",
    "first-install-receipt",
    "truncated",
    "stale-project",
    "canceled",
  ] as const)("measures capture-only current cache before Factory (%s)", async (scenario) => {
  const f = await fixture();
  const first = readCrabboxRuntimeInstallation((await f.execute()).stdout, f.identity);
  const bundleHash = "e".repeat(64);
  const descriptor: CrabboxSnapshotVerifierInput = {
    schema: "openclaw.snapshot-verifier-input.v1",
    preparedProject: {
      namespace: "synthetic",
      seedKey: "a".repeat(64),
      cacheKey: "b".repeat(64),
      workspaceDir: "/synthetic/workspace",
      homeDir: "/synthetic/project-home",
      baseCommit: "c".repeat(40),
      sourceManifestRef: "sha256:" + "d".repeat(64),
      preparedManifestRef: "sha256:" + "e".repeat(64),
    },
    currentRuntime: {
      ...f.identity,
      workerBundle: { ...f.identity.workerBundle, bundleHash },
      installationVerification: first,
    },
  };
  const original = JSON.stringify(descriptor);
  const factoryReceipt = {
    preEnrollment: {
      schema: "crabbox.pre-enrollment-state.v1",
      credentialEnvironmentAbsent: true,
      credentialAndSessionPathsAbsent: true,
      workerStateLimitedToPreparedCaches: true,
      workspaceEmpty: true,
    },
    checkedCredentialPathsAbsent: true,
    preparedRuntime: {
      runtimeImage: "registry.example/synthetic@sha256:" + "a".repeat(64),
      buildId: f.identity.nodeBootstrap.buildId,
      runtimeVersion: f.identity.nodeBootstrap.openclawVersion,
      enabledPluginIds: f.identity.nodeBootstrap.enabledPluginIds,
      nodeBootstrapSha256: f.identity.nodeBootstrap.sha256,
      workerBundleSha256: f.identity.workerBundle.sha256,
      bundleHash,
      cacheHitVerified: true,
    },
  };
  // A real child consumes only the unchanged private descriptor; no provider module exists here.
  const factory = `let input="";process.stdin.on("data",b=>input+=b);process.stdin.on("end",()=>{
    const value=JSON.parse(input);const fact=value.currentRuntime.installationVerification;
    if(fact?.disposition!=="existing-verified") {process.exitCode=7;return;}
    process.stdout.write(JSON.stringify({...${JSON.stringify(factoryReceipt)},capturedInput:value}));
  });`;
  const profile = resolveCrabboxProvisionProfile(
    {
      provider: "azure-sandbox",
      class: "standard",
      ttl: "4h",
      idleTimeout: "60m",
      azureSandboxDiskId: "synthetic-disk",
      sdkPython: "/synthetic/python",
      configFile: "/synthetic/config",
      sdkIdentity: { kind: "azure-cli" },
      snapshotVerifier: [process.execPath, "-e", factory],
    },
    undefined,
  ).profile;
  const signal = new AbortController();
  let current = true;
  const stages: string[] = [];
  vi.spyOn(processRunner, "runCrabboxProcess").mockImplementation(async (argv, options) => {
    expect(argv[0]).toBe("synthetic-crabbox");
    expect(argv).toContain("--no-sync");
    expect(argv[argv.indexOf("--id") + 1]).toBe("synthetic-builder");
    const input = String(options.input);
    const isFactory = input.includes("OPENCLAW_SNAPSHOT_VERIFIER");
    stages.push(isFactory ? "factory" : "runtime");
    let output;
    try {
      output = await run("/bin/sh", ["-c", input], {
        env: f.env,
        signal: options.signal,
        timeout: 30_000,
      });
    } catch (error) {
      if (!isFactory && scenario === "missing-current") {
        return commandResult({ code: 1, stderr: "synthetic-private-failure" });
      }
      throw error;
    }
    if (!isFactory) {
      if (scenario === "receipt-identity" || scenario === "first-install-receipt") {
        output.stdout =
          "OPENCLAW_RUNTIME_INSTALLED:" +
          JSON.stringify({
            ...first,
            disposition: scenario === "first-install-receipt" ? "installed" : "existing-verified",
            ...(scenario === "receipt-identity"
              ? { nodeBootstrap: { ...first.nodeBootstrap, buildId: "wrong-current-build" } }
              : {}),
          });
      }
      if (scenario === "stale-project") {
        current = false;
      }
      if (scenario === "canceled") {
        signal.abort(new Error("Synthetic capture canceled"));
      }
    }
    return commandResult({
      ...output,
      ...(!isFactory && scenario === "truncated" ? { stdoutTruncatedBytes: 1 } : {}),
    });
  });
  if (scenario === "missing-current") {
    fs.rmSync(f.runtime, { recursive: true });
  }
  const cacheEntries = () =>
    fs
      .readdirSync(f.runtimeRoot, { recursive: true, encoding: "utf8" })
      .toSorted((a, b) => a.localeCompare(b));
  const before = cacheEntries();
  const prepare = prepareCrabboxAzureSnapshotCapture(
    {
      binary: "synthetic-crabbox",
      id: "synthetic-builder",
      provider: "azure-sandbox",
      profile,
      azureSnapshot: {
        scope: {
          region: "synthetic",
          subscriptionId: "synthetic",
          resourceGroup: "synthetic",
          group: "synthetic",
        },
        providerScope: "synthetic-scope",
        sdkPython: "/synthetic/python",
        helperPath: "/synthetic/snapshot.py",
        providerEnv: {},
      },
      timingIdentity: { operationId: "synthetic-capture" },
      signal: signal.signal,
      assertCurrent: () => {
        signal.signal.throwIfAborted();
        if (!current) {
          throw new Error("Synthetic project owner changed");
        }
      },
    },
    {
      inspection: {
        id: "synthetic-builder",
        state: "running",
        tailscaleEnabled: false,
        azureSandboxId: "synthetic-sandbox",
      },
      runtimeIdentity: {
        nodeBootstrapSha256: f.identity.nodeBootstrap.sha256,
        workerBundleSha256: f.identity.workerBundle.sha256,
        executionMode: "worker-turn",
      },
      captureId: "synthetic-capture",
      verifySnapshot: async () => descriptor,
    },
  );
  if (scenario === "current") {
    const result = await prepare;
    const receipt = JSON.parse(result.admission.verifier);
    expect(receipt.capturedInput.currentRuntime.installationVerification).toEqual({
      ...first,
      disposition: "existing-verified",
    });
    expect(stages).toEqual(["runtime", "factory"]);
  } else {
    await expect(prepare).rejects.toThrow(
      scenario === "canceled"
        ? "Synthetic capture canceled"
        : scenario === "stale-project"
          ? "Synthetic project owner changed"
          : "Snapshot runtime cache verification",
    );
    await expect(prepare).rejects.not.toThrow("synthetic-private-failure");
    expect(stages).toEqual(["runtime"]);
  }
  expect(JSON.stringify(descriptor)).toBe(original);
  expect(first.disposition).toBe("installed");
  expect(cacheEntries()).toEqual(before);
  expect(fs.existsSync(path.join(f.home, ".openclaw"))).toBe(false);
});
