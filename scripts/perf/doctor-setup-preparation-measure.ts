/**
 * Isolated Doctor setup preparation, including fresh callbacks and awaited phase cleanup.
 * Run the same file on each revision with --route legacy or --route prepared.
 * Use the pinned Bun, serial A/A and alternating A/B processes, and new --output directories.
 * These phase times exclude fixture creation/imports and are not whole-Doctor timings.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { loadavg } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { isMainThread } from "node:worker_threads";
import {
  captureRetainedNativeWorkerSource,
  closeDefaultRetainedNativeWorkerSource,
} from "../../src/infra/worker-native-lifecycle.js";
import {
  doctorFsOperations,
  installDoctorFsMetrics,
  type DoctorFsMetrics,
} from "../../src/plugins/doctor-capture-probe.test-support.js";
import * as doctor from "../../src/plugins/doctor-contract-registry.js";
import { createDoctorGenerationFixture } from "../../src/plugins/doctor-generation.test-support.js";
import { createPluginCache, withPluginCache } from "../../src/plugins/plugin-cache.js";
import { withPluginGenerationSourceCustody } from "../../src/plugins/plugin-generation-source-lookup.js";
import { withPluginSourceCaptureStorage } from "../../src/plugins/plugin-source-capture-context.js";
import { withArtifactPreservingStateReads } from "../../src/state/artifact-preserving-state-reads.js";

assert(isMainThread, "Doctor measurements must use the application main thread");
const { values } = parseArgs({
  options: {
    output: { type: "string" },
    route: { type: "string" },
    files: { type: "string", default: "128" },
    phases: { type: "string", default: "3" },
  },
});
assert(
  values.output && path.isAbsolute(values.output),
  "--output must be a new absolute directory",
);
assert(
  values.route === "legacy" || values.route === "prepared",
  "--route must be legacy or prepared",
);
const files = Number(values.files);
const phases = Number(values.phases);
assert(Number.isSafeInteger(files) && files > 0);
assert(Number.isSafeInteger(phases) && phases > 0);
const preparation = fs.existsSync(
  new URL("../../src/plugins/doctor-contract-preparation.ts", import.meta.url),
)
  ? await import("../../src/plugins/doctor-contract-preparation.js")
  : undefined;
const prepare = preparation?.preparePluginDoctorContractModules;
assert(
  values.route !== "prepared" || prepare,
  "Prepared Doctor entry point is missing on this revision",
);
const output = values.output;
fs.mkdirSync(output, { mode: 0o700 });
const sourceRoot = path.join(output, "source");
const stateDir = path.join(output, "state");
fs.mkdirSync(sourceRoot);
fs.mkdirSync(stateDir);
const payloads = Array.from(
  { length: files },
  (_, index) => `payload-${String(index).padStart(5, "0")}.txt`,
);
const bytes = payloads.map((_, index) => `synthetic file ${index}\n`.repeat(256));
fs.writeFileSync(path.join(sourceRoot, "package.json"), JSON.stringify({ type: "module" }));
fs.writeFileSync(path.join(sourceRoot, "asset.txt"), "original resource");
fs.writeFileSync(
  path.join(sourceRoot, "doctor-contract-api.mjs"),
  `
  import fs from "node:fs"; import { createHash } from "node:crypto";
  let calls = 0;
  export const stateMigrations = [{ id: "repair", label: "repair",
    detectLegacyState() { return { preview: ["fixture"] }; },
    migrateLegacyState() {
      const asset = new URL("./asset.txt", import.meta.url);
      const resource = fs.readFileSync(asset, "utf8");
      const hash = createHash("sha256");
      for (const file of ${JSON.stringify(payloads)}) hash.update(fs.readFileSync(new URL(file, import.meta.url)));
      fs.writeFileSync(asset, "changed by callback");
      return { changes: [String(++calls), resource, hash.digest("hex"), import.meta.url], warnings: [] };
    }
  }];
`,
);
for (const [index, name] of payloads.entries())
  fs.writeFileSync(path.join(sourceRoot, name), bytes[index]!);
const originalBytes = fs
  .readdirSync(sourceRoot)
  .reduce((sum, name) => sum + fs.statSync(path.join(sourceRoot, name)).size, 0);
const expectedHash = createHash("sha256").update(bytes.join("")).digest("hex");
const fixture = createDoctorGenerationFixture(sourceRoot, "measure");
const inventory = fixture.inventory({ stateMigrations: [{ id: "repair" }] });
const telemetry = fs.existsSync(
  new URL("../../src/plugins/plugin-generation-metrics.ts", import.meta.url),
)
  ? await import("../../src/plugins/plugin-generation-metrics.js")
  : undefined;
const generation = telemetry?.createPluginGenerationMetrics();
const metrics: DoctorFsMetrics = {
  calls: new Int32Array(new SharedArrayBuffer(2 * doctorFsOperations.length * 4)),
  readBytes: new Int32Array(new SharedArrayBuffer(8)),
  writeBytes: new Int32Array(new SharedArrayBuffer(8)),
  rawCopyBytes: new Int32Array(new SharedArrayBuffer(8)),
};
const nativeSource = captureRetainedNativeWorkerSource({ runtimeGeneration: undefined });
const createWorker = nativeSource.create.bind(nativeSource);
nativeSource.create = (filename, options = {}, ...rest) =>
  createWorker(
    new URL("../../src/plugins/doctor-capture-probe.test-support.ts", import.meta.url),
    {
      ...options,
      workerData: {
        ...options.workerData,
        doctorFsMetrics: metrics,
        doctorCaptureWorkerUrl: String(filename),
      },
    },
    ...rest,
  );
const restoreFs = installDoctorFsMetrics(metrics, 0);
const snapshotFs = () => ({
  host: Object.fromEntries(
    doctorFsOperations.map((name, index) => [name, Atomics.load(metrics.calls, index)]),
  ),
  worker: Object.fromEntries(
    doctorFsOperations.map((name, index) => [
      name,
      Atomics.load(metrics.calls, doctorFsOperations.length + index),
    ]),
  ),
  readSyncBytes: [...metrics.readBytes],
  writeSyncBytes: [...metrics.writeBytes],
  rawCopyBytes: [...metrics.rawCopyBytes],
});
let expectedTimer = performance.now() + 5;
let maxDelayMs = 0;
let ticks = 0;
const timer = setInterval(() => {
  const now = performance.now();
  maxDelayMs = Math.max(maxDelayMs, now - expectedTimer);
  expectedTimer = now + 5;
  ticks++;
}, 5);
const rows: unknown[] = [];
const sourceDigests: string[] = [];
const privateUrls: string[] = [];
const hostLoad = loadavg();
const cpuStart = process.cpuUsage();
const hostCpuStart = process.threadCpuUsage();
const start = performance.now();
const run = () =>
  withArtifactPreservingStateReads(() =>
    withPluginSourceCaptureStorage({ stateDir, placement: "temporary" }, () =>
      withPluginGenerationSourceCustody(async () => {
        for (let phase = 0; phase < phases; phase++) {
          await delay(10);
          maxDelayMs = 0;
          const before = snapshotFs();
          const started = performance.now();
          {
            await using cache = createPluginCache();
            await withPluginCache(cache, async () => {
              if (values.route === "prepared")
                await prepare!({ inventory, surfaces: ["stateMigrations"] });
              const entry = doctor.listPluginDoctorStateMigrationEntries({ inventory })[0];
              assert(entry, "Doctor contribution must not be silently skipped");
              const result = await entry.migration.migrateLegacyState(fixture.input);
              assert.deepEqual(result.changes.slice(0, 3), [
                "1",
                "original resource",
                expectedHash,
              ]);
              const digest = [...cache.setupModules.values()][0]!.sourceDigest;
              assert(digest);
              sourceDigests.push(digest);
              privateUrls.push(result.changes[3]!);
            });
          }
          const elapsedMs = performance.now() - started;
          await delay(10);
          rows.push({
            phase,
            elapsedMs,
            maxDelayMs,
            before,
            after: snapshotFs(),
            generation: generation ? { ...generation } : undefined,
          });
        }
      }),
    ),
  );
try {
  await (telemetry && generation ? telemetry.withPluginGenerationMetrics(generation, run) : run());
  assert.equal(
    new Set(sourceDigests).size,
    1,
    "Receipt digest must match across independent phase instances",
  );
  assert.equal(
    new Set(privateUrls).size,
    phases,
    "Each phase must own a private callback instance",
  );
  assert.equal(
    nativeSource.hasActiveWorkers,
    false,
    "Custody cleanup must finish before measurement settles",
  );
} finally {
  clearInterval(timer);
  restoreFs();
  nativeSource.create = createWorker;
  await closeDefaultRetainedNativeWorkerSource();
}
const elapsedMs = performance.now() - start;
const cpu = process.cpuUsage(cpuStart);
const hostCpu = process.threadCpuUsage(hostCpuStart);
const result = {
  route: values.route,
  isMainThread,
  runtime: process.versions,
  files: files + 3,
  originalBytes,
  phases,
  hostLoad,
  hostLoadEnd: loadavg(),
  elapsedMs,
  processCpuMs: (cpu.user + cpu.system) / 1000,
  hostCpuMs: (hostCpu.user + hostCpu.system) / 1000,
  ticks,
  sourceDigest: sourceDigests[0],
  payloadHash: expectedHash,
  rows,
  totalFs: snapshotFs(),
  generation,
};
fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2) + "\n");
fs.rmSync(sourceRoot, { recursive: true });
fs.rmSync(stateDir, { recursive: true });
console.log(JSON.stringify(result));
