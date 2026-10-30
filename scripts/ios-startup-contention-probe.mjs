// Temporary boot-only attribution, not screenshot performance qualification.
// Acceptance: boot one fresh simulator, retain bounded CPU/I/O observations,
// and confirm cleanup. Missing/denied counters never imply idle processes.
import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const [output, counter] = process.argv.slice(2);
if (!output || !counter || process.platform !== "darwin") {
  throw new Error("Expected output path and compiled counter on macOS.");
}
mkdirSync(path.dirname(output), { recursive: true });
let phase = "preflight";
let timer;
let sampling = true;
let pendingSample;
let previousAt;
let count = 0;
let bytes = 0;
const emit = (record) => {
  const line = `${JSON.stringify({ at: new Date().toISOString(), phase, ...record })}\n`;
  if (
    record.type === "task-sample" &&
    (count >= 110 || bytes + Buffer.byteLength(line) > 16 * 1024 * 1024)
  ) {
    sampling = false;
    emit({ type: "observer-output-limit" });
    return;
  }
  appendFileSync(output, line, { mode: 0o600 });
  count++;
  bytes += Buffer.byteLength(line);
};
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
function cpuTimes() {
  return os.cpus().reduce((sum, cpu) => {
    for (const [key, value] of Object.entries(cpu.times)) sum[key] = (sum[key] ?? 0) + value;
    return sum;
  }, {});
}
let previousCpu = cpuTimes();
async function sample() {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const phaseAtStart = phase;
  try {
    const census = JSON.parse(
      await run(
        "/usr/bin/sudo",
        ["-n", "/usr/bin/nice", "-n", "10", "/usr/bin/python3", counter],
        7_000,
      ),
    );
    if (census.outcome !== "ok") sampling = false;
    const currentCpu = cpuTimes();
    const cpuDeltas = Object.fromEntries(
      Object.keys(currentCpu).map((key) => [key, currentCpu[key] - previousCpu[key]]),
    );
    const total = Object.values(cpuDeltas).reduce((sum, n) => sum + n, 0);
    emit({
      type: "task-sample",
      startedAt,
      phaseAtStart,
      wallMs: Math.round(performance.now() - started),
      intervalMs: previousAt === undefined ? null : Math.round(started - previousAt),
      hostCpuPercent:
        previousAt === undefined
          ? null
          : Object.fromEntries(
              Object.entries(cpuDeltas).map(([key, n]) => [key, total ? (100 * n) / total : null]),
            ),
      load: os.loadavg(),
      ...census,
    });
    previousAt = started;
    previousCpu = currentCpu;
  } catch {
    sampling = false;
    emit({
      type: "observer-unavailable",
      startedAt,
      phaseAtStart,
      wallMs: Math.round(performance.now() - started),
    });
  }
  if (sampling) timer = setTimeout(collect, 10_000);
}
function collect() {
  pendingSample = sample();
}
async function measured(label, fn) {
  phase = label;
  const started = performance.now();
  emit({ type: "phase-start" });
  try {
    const result = await fn();
    emit({ type: "phase-end", outcome: "ok", wallMs: Math.round(performance.now() - started) });
    return result;
  } catch (error) {
    emit({ type: "phase-end", outcome: "failed", wallMs: Math.round(performance.now() - started) });
    throw error;
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
let owned;
emit({
  type: "start",
  cpuCount: os.availableParallelism(),
  totalMemoryBytes: os.totalmem(),
  intervalMs: 10_000,
  observerTimeoutMs: 7_000,
  workload: "fresh-iphone-boot-no-app-no-xctest",
  counterApi: "Apple-powermetrics-tasks-1s-sample",
  sourceSha: process.env.GITHUB_SHA ?? "local",
});
collect();
try {
  const initial = await devices();
  if (initial.some((row) => row.state !== "Shutdown"))
    throw new Error("Existing active simulators; left unchanged.");
  const template = initial.find((row) => /^iPhone .* Pro Max$/u.test(row.name));
  if (!template) throw new Error("No available Pro Max simulator template.");
  emit({ type: "template", deviceName: template.name, runtime: template.runtime });
  await measured("host-idle", () => sleep(20_000));
  await measured("headroom", async () => {
    const result = JSON.parse(
      await run("node", ["scripts/lib/ios-simulator-headroom.ts"], 310_000),
    );
    emit({ type: "headroom", ...result });
  });
  owned = (
    await measured("create", () =>
      run("xcrun", [
        "simctl",
        "create",
        "OpenClaw startup CPU probe",
        template.deviceTypeIdentifier,
        template.runtime,
      ]),
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
    ) {
      throw new Error("Owned simulator is not exclusively Booted.");
    }
  });
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
    sampling = false;
    clearTimeout(timer);
    await pendingSample;
    clearTimeout(timer);
    emit({ type: "end" });
  }
}
