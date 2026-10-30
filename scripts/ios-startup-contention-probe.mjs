// Temporary screening: same Xcode 27.1/27A9275, iOS 27.0, iPhone 18 Pro Max.
// First screen one fresh runner per size, baseline then candidate. Continue to
// five interleaved samples each only if the candidate's create-to-ready time is
// at least 20% lower with successful exclusive readiness and cleanup. A qualified
// boot improvement needs >=20% lower median and no >20% p95 regression. This
// blank boot cannot qualify screenshot memory, rendering, or end-to-end speed.
import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const [output] = process.argv.slice(2);
if (!output || process.platform !== "darwin") throw new Error("Expected output path on macOS.");
mkdirSync(path.dirname(output), { recursive: true });
let phase = "preflight";
const emit = (record) =>
  appendFileSync(
    output,
    `${JSON.stringify({ at: new Date().toISOString(), phase, ...record })}\n`,
    { mode: 0o600 },
  );

function cpuTimes() {
  return os.cpus().reduce(
    (sum, cpu) => ({
      idle: sum.idle + cpu.times.idle,
      total: sum.total + Object.values(cpu.times).reduce((total, value) => total + value, 0),
    }),
    { idle: 0, total: 0 },
  );
}

function run(command, args, timeout = 120_000) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) =>
        error
          ? reject(
              new Error(
                `Diagnostic command failed in ${phase}: ${error.killed ? "timeout" : error.code}`,
              ),
            )
          : resolve(stdout),
    );
  });
}

async function measured(label, fn) {
  phase = label;
  const started = performance.now();
  const before = cpuTimes();
  emit({ type: "phase-start" });
  let outcome = "failed";
  try {
    const result = await fn();
    outcome = "ok";
    return result;
  } finally {
    const wallMs = Math.round(performance.now() - started);
    const after = cpuTimes();
    const total = after.total - before.total;
    emit({
      type: "phase-end",
      outcome,
      wallMs,
      idlePercent: total > 0 ? (100 * (after.idle - before.idle)) / total : null,
      freeMemoryBytes: os.freemem(),
      load: os.loadavg(),
    });
  }
}

async function devices() {
  const result = JSON.parse(
    await run("xcrun", ["simctl", "list", "devices", "available", "--json"]),
  );
  return Object.entries(result.devices).flatMap(([runtime, rows]) =>
    rows.map((row) => ({ runtime, ...row })),
  );
}

const runtime = "com.apple.CoreSimulator.SimRuntime.iOS-27-0";
const deviceType = "com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro-Max";
let owned;
emit({
  type: "start",
  cpuCount: os.availableParallelism(),
  cpuModel: os.cpus()[0]?.model,
  arch: os.arch(),
  totalMemoryBytes: os.totalmem(),
  imageOS: process.env.ImageOS,
  imageVersion: process.env.ImageVersion,
  runnerLabel: process.env.PROBE_RUNNER_LABEL,
  sourceSha: process.env.GITHUB_SHA ?? "local",
  nodeVersion: process.version,
  workload: "fresh-iphone-boot-no-app-no-xctest-no-profiler",
});
try {
  const xcode = (await run("xcodebuild", ["-version"])).trim();
  emit({
    type: "toolchain",
    xcode,
    macOS: (await run("sw_vers", ["-productVersion"])).trim(),
    osBuild: (await run("sw_vers", ["-buildVersion"])).trim(),
  });
  if (xcode !== "Xcode 27.1\nBuild version 27A9275") throw new Error("Unmatched Xcode toolchain.");
  const initial = await devices();
  if (initial.some((row) => row.state !== "Shutdown"))
    throw new Error("Existing active simulators; left unchanged.");
  if (!initial.some((row) => row.runtime === runtime && row.deviceTypeIdentifier === deviceType))
    throw new Error("Required simulator template unavailable.");
  const selected = JSON.parse(
    await run("xcrun", ["simctl", "list", "runtimes", "--json"]),
  ).runtimes.find((row) => row.identifier === runtime && row.isAvailable);
  if (!selected) throw new Error("Required runtime unavailable.");
  emit({
    type: "template",
    deviceName: "iPhone 18 Pro Max",
    runtime,
    runtimeVersion: selected.version,
    runtimeBuild: selected.buildversion,
  });
  await measured("host-idle", () => sleep(20_000));
  await measured("headroom", async () => {
    const result = JSON.parse(
      await run("node", ["scripts/lib/ios-simulator-headroom.ts"], 310_000),
    );
    emit({ type: "headroom", ...result });
  });
  const coldStarted = performance.now();
  owned = (
    await measured("create", () =>
      run("xcrun", ["simctl", "create", "OpenClaw runner comparison", deviceType, runtime]),
    )
  ).trim();
  if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(owned))
    throw new Error("Invalid owned simulator UUID.");
  await measured("bootstatus", () => run("xcrun", ["simctl", "bootstatus", owned, "-b"], 240_000));
  await measured("postboot-inventory", async () => {
    const rows = await devices();
    if (
      rows.find((row) => row.udid === owned)?.state !== "Booted" ||
      rows.some((row) => row.udid !== owned && row.state !== "Shutdown")
    )
      throw new Error("Owned simulator is not exclusively Booted.");
  });
  emit({ type: "cold-ready", wallMs: Math.round(performance.now() - coldStarted) });
  await measured("simulator-idle-no-app", () => sleep(120_000));
} finally {
  try {
    if (owned && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(owned)) {
      try {
        await measured("shutdown", () => run("xcrun", ["simctl", "shutdown", owned]));
      } finally {
        await measured("delete", () => run("xcrun", ["simctl", "delete", owned]));
      }
    }
  } finally {
    emit({ type: "end" });
  }
}
