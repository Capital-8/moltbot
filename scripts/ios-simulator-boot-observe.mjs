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
  kind: "stock-boot-diagnostic-not-qualification",
  targetSha: process.env.GITHUB_SHA,
  imageVersion: process.env.ImageVersion,
  nodeVersion: process.version,
  cpuCount: os.cpus().length,
  availableParallelism: os.availableParallelism(),
  totalMemoryBytes: os.totalmem(),
  runtimeIdentifier,
  deviceType,
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
let createAttempted = false;
const started = performance.now();
const save = () => writeFileSync(output, `${JSON.stringify(proof, null, 2)}\n`);
async function command(bin, args, timeoutMs = 120_000, cleanup = false) {
  let stdout = "";
  const code = await runManagedCommand({
    bin,
    args,
    stdio: ["ignore", "pipe", "pipe"],
    timeoutMs,
    requireProcessTreeExit: true,
    signal: cleanup ? undefined : controller.signal,
    onReady(child) {
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
  await phase("baseline", () => sleep(20_000, undefined, { signal: controller.signal }));
  await phase("create", async () => {
    createAttempted = true;
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
  proof.status = "passed";
} catch {
  proof.failedStage = stage;
  process.exitCode = 1;
} finally {
  try {
    if (udid) {
      await phase("cleanup", () => command("xcrun", ["simctl", "delete", udid], 120_000, true));
    }
    proof.cleanupConfirmed = Boolean(udid) || !createAttempted;
  } catch {
    proof.status = "failed";
    proof.cleanupConfirmed = false;
    process.exitCode = 1;
  }
  proof.elapsedMs = Math.round(performance.now() - started);
  save();
  for (const [signal, handler] of handlers) {
    process.off(signal, handler);
  }
}
