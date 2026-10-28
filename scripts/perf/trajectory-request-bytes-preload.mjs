/**
 * Capture real trajectory append commands and measure their V8 transport encoding.
 * node --expose-gc --import ./scripts/tsx.mjs \
 *   --import ./scripts/perf/trajectory-request-bytes-preload.mjs \
 *   scripts/perf/trajectory-persistence.ts --state-dir "$PWD/.local/trajectory-bytes" \
 *   --mode timing --turns 5
 * Run against base and candidate with fresh state; compare persisted golden bytes.
 * Optional source overlays use worker-retained-heap-preload.ts before this preload.
 * The persistence workload exercises real recorder, writer FIFO, worker and SQLite.
 * This probe retains only its synthetic append commands. After database shutdown,
 * five untraced transport passes and one sampled-allocation pass replay 2,000
 * commands each. CPU includes serialize + deserialize, excluding SQLite/compression.
 * Event-type bytes include their serialized wrapper, not shared request overhead.
 * Acceptance: unchanged stored bytes/run attribution, fewer request bytes and no
 * adverse transport CPU/allocation. Whole-Gateway latency is not measured here.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import { deserialize, serialize } from "node:v8";

const requests = [];
const captureKey = Symbol.for("openclaw.perf.trajectory-request-bytes");
globalThis[captureKey] = (command) => {
  const bytes = serialize(command);
  if (command.type === "trajectory.events.append") {
    requests.push({ command: deserialize(bytes), bytes: bytes.byteLength });
  }
  return bytes;
};
const replacement = `data:text/javascript,${encodeURIComponent(`
export const serialize = globalThis[Symbol.for("openclaw.perf.trajectory-request-bytes")];
`)}`;
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "node:v8" && /\/sqlite-worker-client\.[jt]s$/.test(context.parentURL ?? "")) {
      return { url: replacement, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

async function measure() {
  hook.deregister();
  delete globalThis[captureKey];
  assert(global.gc, "Use --expose-gc");
  assert(requests.length > 0, "No real trajectory append requests captured");
  const byType = new Map();
  for (const { command } of requests) {
    for (const event of command.input.events) {
      const { type, runId } = JSON.parse(event.line);
      assert.equal(command.input.runId ?? event.runId, runId);
      const summary = byType.get(type) ?? { events: 0, bytes: 0 };
      summary.events++;
      summary.bytes += serialize(event).byteLength;
      byType.set(type, summary);
    }
  }
  const iterations = 2000;
  let checksum = 0;
  const run = () => {
    for (let index = 0; index < iterations; index++) {
      const { command } = requests[index % requests.length];
      const decoded = deserialize(serialize(command));
      checksum += decoded.input.events.length;
    }
  };
  run();
  const timing = [];
  for (let pass = 0; pass < 5; pass++) {
    global.gc();
    const cpu = process.threadCpuUsage();
    const start = performance.now();
    run();
    const elapsed = process.threadCpuUsage(cpu);
    timing.push({
      iterations,
      cpuUsPerAppend: (elapsed.user + elapsed.system) / iterations,
      wallMs: performance.now() - start,
    });
  }
  global.gc();
  const inspector = new Session();
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 4096,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  run();
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  inspector.disconnect();
  console.log(
    JSON.stringify({
      trajectoryRequestBytes: {
        requests: requests.length,
        requestBytes: requests.map(({ bytes }) => bytes),
        byType: Object.fromEntries(byType),
        timing,
        allocation: {
          iterations,
          sampledBytesPerAppend:
            profile.samples.reduce((sum, sample) => sum + sample.size, 0) / iterations,
          samples: profile.samples.length,
        },
        hostLoad: loadavg(),
        checksum,
      },
    }),
  );
}

process.once("beforeExit", () => {
  void measure().catch((/** @type {unknown} */ error) => {
    console.error(error);
    process.exitCode = 1;
  });
});
