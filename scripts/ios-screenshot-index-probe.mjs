import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

// Diagnostic-only comparison: clean products through the real screenshot lane,
// then use its existing headroom check and stop before creating a simulator.
const output = path.join(process.env.RUNNER_TEMP, "ios-index-probe");
mkdirSync(output, { recursive: true });
const fastfile = "apps/ios/fastlane/Fastfile";
const original = readFileSync(fastfile, "utf8");
const marker = `    if ENV["OPENCLAW_SNAPSHOT_STARTUP_PROBE"] == "1"
      screenshot_phase(diagnostics, "host-idle") { sleep(60) }`;
const archMarker =
  '          "ARCHS=#{RbConfig::CONFIG.fetch("host_cpu")}", "ONLY_ACTIVE_ARCH=YES",\n';
if (original.split(marker).length !== 2 || original.split(archMarker).length !== 2) {
  throw new Error("Expected unique screenshot build and postbuild boundaries");
}
const stop = `    screenshot_phase(diagnostics, "headroom") do
      sh("node", File.join(repo_root, "scripts", "lib", "ios-simulator-headroom.ts"))
    end
    next
`;
const baseline = original.replace(marker, stop + marker);
const candidate = baseline.replace(
  archMarker,
  archMarker + '          "COMPILER_INDEX_STORE_ENABLE=NO",\n',
);
const sample = Number(process.argv[2]);
if (!Number.isInteger(sample) || sample < 1 || sample > 10) {
  throw new Error("Expected sample number 1 through 10");
}
const variant = sample % 2 === 1 ? "baseline" : "candidate";
const directory = path.join(output, `${String(sample).padStart(2, "0")}-${variant}`);
mkdirSync(directory, { recursive: true });
function inventory(directory) {
  let files = 0;
  let bytes = 0;
  if (existsSync(directory)) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        const nested = inventory(fullPath);
        files += nested.files;
        bytes += nested.bytes;
      } else if (entry.isFile()) {
        files++;
        bytes += statSync(fullPath).size;
      }
    }
  }
  return { files, bytes };
}
const started = new Date().toISOString();
const loadBefore = os.loadavg();
let child;
try {
  writeFileSync(fastfile, variant === "baseline" ? baseline : candidate);
  child = spawnSync("/bin/bash", ["scripts/ios-screenshots.sh"], {
    stdio: "inherit",
    env: { ...process.env, OPENCLAW_SNAPSHOT_DIAGNOSTICS: "1" },
  });
} finally {
  writeFileSync(fastfile, original);
  for (const [source, name] of [
    ["apps/ios/build/SnapshotLogs/build.log", "build.log"],
    ["apps/ios/build/screenshot-diagnostics.json", "diagnostics.json"],
  ]) {
    if (existsSync(source)) copyFileSync(source, path.join(directory, name));
  }
}
const ended = new Date().toISOString();
const buildLog = path.join(directory, "build.log");
const log = existsSync(buildLog) ? readFileSync(buildLog, "utf8") : "";
const commands = log
  .split("\n")
  .filter((line) => / -module-name /.test(line) && /swiftc|SwiftDriver/.test(line));
const diagnosticsPath = path.join(directory, "diagnostics.json");
const phases = existsSync(diagnosticsPath)
  ? JSON.parse(readFileSync(diagnosticsPath, "utf8")).diagnostics
  : [];
const build = phases.find((phase) => phase.phase === "build");
const headroom = phases.find((phase) => phase.phase === "headroom");
const row = {
  sample,
  variant,
  started,
  ended,
  source: process.env.GITHUB_SHA,
  xcode: process.env.IOS_SCREENSHOT_XCODE_VERSION,
  image: process.env.ImageVersion,
  cpus: os.cpus().length,
  memoryBytes: os.totalmem(),
  loadBefore,
  loadAfter: os.loadavg(),
  status: child?.status,
  signal: child?.signal,
  error: child?.error?.message,
  wallSeconds: (Date.parse(ended) - Date.parse(started)) / 1000,
  buildSeconds: build?.durationSeconds,
  headroomSeconds: headroom?.durationSeconds,
  combinedSeconds: build && headroom ? build.durationSeconds + headroom.durationSeconds : null,
  swiftCompilerCommands: commands.length,
  swiftIndexCommands: commands.filter((line) => line.includes("-index-store-path")).length,
  indexArgumentLines: log.split("\n").filter((line) => line.includes("-index-store-path")).length,
  indexStore: inventory("apps/ios/build/SnapshotDerivedData/Index.noindex"),
};
appendFileSync(path.join(output, "samples.jsonl"), JSON.stringify(row) + "\n");
console.log(JSON.stringify(row));
if (
  child?.status !== 0 ||
  commands.length === 0 ||
  build?.outcome !== "succeeded" ||
  headroom?.outcome !== "succeeded"
) {
  throw new Error(`Sample ${sample} did not complete the screenshot build and headroom check`);
}
if (
  variant === "baseline"
    ? row.swiftIndexCommands === 0 || row.indexStore.files === 0
    : row.indexArgumentLines !== 0 || row.indexStore.files !== 0
) {
  throw new Error(`Sample ${sample} has unexpected index output`);
}
