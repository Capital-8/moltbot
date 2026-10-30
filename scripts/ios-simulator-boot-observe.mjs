// Temporary diagnosis only: no OpenClaw build, Gateway, XCTest, or qualification result.
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import os from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { markIosResourcePhase } from "./ios-resource-timeline.mjs";
import { waitForIOSSimulatorHeadroom } from "./lib/ios-simulator-headroom.ts";
import { runManagedCommand } from "./lib/managed-child-process.mts";

const output = process.argv[2];
if (!output || process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("proof-path-and-macos-arm64-required");
}
const runtimeIdentifier = "com.apple.CoreSimulator.SimRuntime.iOS-27-0";
const deviceType = "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro";
const proof = {
  kind: "blank-seed-clone-diagnostic-not-qualification",
  targetSha: process.env.GITHUB_SHA,
  imageVersion: process.env.ImageVersion,
  nodeVersion: process.version,
  cpuCount: os.cpus().length,
  availableParallelism: os.availableParallelism(),
  totalMemoryBytes: os.totalmem(),
  runtimeIdentifier,
  deviceType,
  inheritedLoggingOverrides: [
    "SIMCTL_CHILD_OS_ACTIVITY_MODE",
    "SIMCTL_CHILD_OS_ACTIVITY_DT_MODE",
    "SIMCTL_CHILD_OS_LOG_DT_HOOK_MODE",
    "SIMCTL_CHILD_IDE_DISABLED_OS_ACTIVITY_DT_MODE",
  ].map((name) => ({ name, present: Object.hasOwn(process.env, name) })),
  status: "failed",
  phases: [],
  cleanupConfirmed: false,
};
const controller = new AbortController();
const handlers = new Map(
  ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => {
    const handler = () => controller.abort();
    process.on(signal, handler);
    return [signal, handler];
  }),
);
let stage = "preflight";
let udid;
let cloneUdid;
let creationAttempts = 0;
const ownedDevices = [];
const started = performance.now();
const save = () => writeFileSync(output, `${JSON.stringify(proof, null, 2)}\n`);
async function command(bin, args, timeoutMs = 120_000, cleanup = false, input = "") {
  let stdout = "";
  const code = await runManagedCommand({
    bin,
    args,
    stdio: ["pipe", "pipe", "pipe"],
    timeoutMs,
    requireProcessTreeExit: true,
    signal: cleanup ? undefined : controller.signal,
    onReady(child) {
      child.stdin.end(input);
      child.stdout.on("data", (chunk) => {
        stdout = (stdout + chunk.toString()).slice(-256 * 1024);
      });
      // Drain raw diagnostics without exporting paths or device identifiers.
      child.stderr.resume();
    },
  });
  if (code !== 0) {
    throw new Error("native-command-failed");
  }
  return stdout.trim();
}
async function phase(label, action) {
  stage = label;
  markIosResourcePhase(`stock-boot-${label}`);
  const entry = { phase: label, startedAt: new Date().toISOString(), status: "running", ms: 0 };
  proof.phases.push(entry);
  save();
  const at = performance.now();
  try {
    const result = await action();
    entry.status = "passed";
    return result;
  } catch (error) {
    entry.status = "failed";
    throw error;
  } finally {
    entry.ms = Math.round(performance.now() - at);
    save();
  }
}
async function loggingStatus(bin, args) {
  const probeStarted = performance.now();
  try {
    const text = await command(bin, args, 5_000);
    // System-level fixed flags only; subsystem/process names and raw config stay private.
    const line = /^System mode = ([A-Z_ ]+)$/mu.exec(text)?.[1];
    const tokens = line?.match(/[A-Z_]+/gu) ?? [];
    const allowed = new Set([
      "DEFAULT",
      "OFF",
      "INFO",
      "DEBUG",
      "PERSIST_DEFAULT",
      "PERSIST_OFF",
      "PERSIST_INFO",
      "PERSIST_DEBUG",
      "STREAM_LIVE",
      "STREAM_DEFAULT",
    ]);
    return {
      outcome:
        line && tokens.length && tokens.every((token) => allowed.has(token))
          ? "recognized"
          : "unrecognized",
      flags: tokens.filter((token) => allowed.has(token)),
      ms: Math.round(performance.now() - probeStarted),
    };
  } catch {
    return { outcome: "unavailable", ms: Math.round(performance.now() - probeStarted) };
  }
}
save();
try {
  const xcode = await command("xcodebuild", ["-version"]);
  if (!/^Xcode 27\.1\nBuild version 27A9275$/u.test(xcode)) {
    throw new Error("different-xcode-image");
  }
  proof.xcode = "27.1";
  proof.xcodeBuild = "27A9275";
  const runtimes = JSON.parse(await command("xcrun", ["simctl", "list", "runtimes", "--json"]));
  const runtime = runtimes.runtimes.find((item) => item.identifier === runtimeIdentifier);
  if (!runtime?.isAvailable || runtime.version !== "27.0") {
    throw new Error("different-runtime-image");
  }
  proof.runtimeBuild = runtime.buildversion;
  proof.hostLogging = await loggingStatus("sudo", ["-n", "/usr/bin/log", "config", "--status"]);
  await phase("baseline", () => sleep(20_000, undefined, { signal: controller.signal }));
  await phase("create", async () => {
    creationAttempts++;
    const created = await command("xcrun", [
      "simctl",
      "create",
      `openclaw-boot-observe-${randomUUID()}`,
      deviceType,
      runtimeIdentifier,
    ]);
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(created)) {
      throw new Error("invalid-created-device-identity");
    }
    udid = created;
    ownedDevices.push(created);
  });
  await phase("boot", () => command("xcrun", ["simctl", "boot", udid]));
  await phase("ready", () => command("xcrun", ["simctl", "bootstatus", udid, "-b"], 600_000));
  await phase("headroom", async () => {
    proof.headroom = await waitForIOSSimulatorHeadroom(controller.signal);
    if (proof.headroom.status !== "ready") {
      throw new Error("headroom-timeout");
    }
  });
  // One ordinary collector interval permits the fixed postgate census, even with no timeout.
  await phase("headroom-passed", () => sleep(25_000, undefined, { signal: controller.signal }));
  proof.simulatorLogging = await loggingStatus("xcrun", [
    "simctl",
    "spawn",
    udid,
    "log",
    "config",
    "--status",
  ]);
  await phase("seed-blank", () => assertOpenClawAbsent(udid));
  await phase("seed-shutdown", () => command("xcrun", ["simctl", "shutdown", udid]));
  await phase("clone", async () => {
    creationAttempts++;
    const created = await command("xcrun", [
      "simctl",
      "clone",
      udid,
      `openclaw-blank-clone-${randomUUID()}`,
    ]);
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(created)) {
      throw new Error("invalid-cloned-device-identity");
    }
    cloneUdid = created;
    ownedDevices.push(created);
  });
  await phase("clone-boot", () => command("xcrun", ["simctl", "boot", cloneUdid]));
  await phase("clone-ready", () =>
    command("xcrun", ["simctl", "bootstatus", cloneUdid, "-b"], 600_000),
  );
  await phase("clone-headroom", async () => {
    proof.cloneHeadroom = await waitForIOSSimulatorHeadroom(controller.signal);
    if (proof.cloneHeadroom.status !== "ready") {
      throw new Error("clone-headroom-timeout");
    }
  });
  await phase("clone-blank", () => assertOpenClawAbsent(cloneUdid));
  const sumPhases = (names) =>
    proof.phases
      .filter((entry) => names.includes(entry.phase))
      .reduce((sum, entry) => sum + entry.ms, 0);
  proof.seedPreparationMs = sumPhases(["create", "boot", "ready", "headroom", "seed-blank"]);
  proof.cloneStartupMs = sumPhases([
    "seed-shutdown",
    "clone",
    "clone-boot",
    "clone-ready",
    "clone-headroom",
    "clone-blank",
  ]);
  proof.totalStartupMs = proof.seedPreparationMs + proof.cloneStartupMs;
  proof.status = "passed";
} catch {
  proof.failedStage = stage;
  process.exitCode = 1;
} finally {
  let deletedDevices = 0;
  for (const device of ownedDevices.toReversed()) {
    try {
      await phase("cleanup", () => command("xcrun", ["simctl", "delete", device], 120_000, true));
      deletedDevices++;
    } catch {
      proof.status = "failed";
      process.exitCode = 1;
    }
  }
  proof.cleanupConfirmed = deletedDevices === creationAttempts;
  proof.ownedDeviceCount = ownedDevices.length;
  proof.deletedDeviceCount = deletedDevices;
  if (!proof.cleanupConfirmed) {
    proof.status = "failed";
    process.exitCode = 1;
  }
  proof.elapsedMs = Math.round(performance.now() - started);
  save();
  for (const [signal, handler] of handlers) {
    process.off(signal, handler);
  }
}

async function assertOpenClawAbsent(device) {
  const listing = await command("xcrun", ["simctl", "listapps", device]);
  const apps = JSON.parse(
    await command("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], 5_000, false, listing),
  );
  // A seed must never carry app containers or pairing state into the clone.
  if (Object.keys(apps).some((id) => id.startsWith("ai.openclawfoundation."))) {
    throw new Error("seed-contains-openclaw");
  }
}
