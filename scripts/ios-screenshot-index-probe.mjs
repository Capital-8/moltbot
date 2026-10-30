import { spawnSync } from "node:child_process";
import {
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

// Diagnostic-only workload: run the normal screenshot entry point, stopping after
// its build and the existing CPU-headroom check, before creating any simulator.
const output = path.join(process.env.RUNNER_TEMP, "ios-index-probe");
mkdirSync(output, { recursive: true });
const fastfile = "apps/ios/fastlane/Fastfile";
const original = readFileSync(fastfile, "utf8");
const marker = `    if ENV["OPENCLAW_SNAPSHOT_STARTUP_PROBE"] == "1"
      screenshot_phase(diagnostics, "host-idle") { sleep(60) }`;
if (original.split(marker).length !== 2)
  throw new Error("Expected one screenshot postbuild boundary");
const stop = `    screenshot_phase(diagnostics, "headroom") do
      sh("node", File.join(repo_root, "scripts", "lib", "ios-simulator-headroom.ts"))
    end
    next
`;
const started = new Date().toISOString();
let child;
try {
  writeFileSync(fastfile, original.replace(marker, stop + marker));
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
    if (existsSync(source)) copyFileSync(source, path.join(output, name));
  }
}
const buildLog = path.join(output, "build.log");
const log = existsSync(buildLog) ? readFileSync(buildLog, "utf8") : "";
const commands = log
  .split("\n")
  .filter((line) => / -module-name /.test(line) && /swiftc|SwiftDriver/.test(line));
const indexCommands = commands.filter((line) => line.includes("-index-store-path"));
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
const result = {
  started,
  ended: new Date().toISOString(),
  source: process.env.GITHUB_SHA,
  xcode: process.env.IOS_SCREENSHOT_XCODE_VERSION,
  image: process.env.ImageVersion,
  cpus: os.cpus().length,
  memoryBytes: os.totalmem(),
  status: child?.status,
  signal: child?.signal,
  error: child?.error?.message,
  swiftCompilerCommands: commands.length,
  swiftIndexCommands: indexCommands.length,
  indexStore: inventory("apps/ios/build/SnapshotDerivedData/Index.noindex"),
};
writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
if (child?.status !== 0 || commands.length === 0) process.exitCode = 1;
