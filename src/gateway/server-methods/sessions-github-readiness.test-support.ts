import { pathToFileURL } from "node:url";
import { getEnvironmentData, setEnvironmentData } from "node:worker_threads";
import { vi } from "vitest";
import * as workerCpu from "../../infra/worker-cpu.js";

export function observeReadinessNativeReads(source: () => string, counts: Int32Array) {
  const create = workerCpu.createCpuTrackedWorker;
  return vi.spyOn(workerCpu, "createCpuTrackedWorker").mockImplementation((filename, options) => {
    if (options?.eval) {
      return create(filename, options);
    }
    const entry = typeof filename === "string" ? pathToFileURL(filename) : filename;
    const key = "openclaw.test.readinessNativeReads";
    const previous = getEnvironmentData(key);
    setEnvironmentData(key, { entry: entry.href, source: source(), counts: counts.buffer });
    try {
      return create(
        new URL("./sessions-github-readiness.native.test-support.mjs", import.meta.url),
        options,
      );
    } finally {
      setEnvironmentData(key, previous);
    }
  });
}
