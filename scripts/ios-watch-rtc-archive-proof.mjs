import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.join(process.env.RUNNER_TEMP, "ios-watch-rtc-proof");
fs.mkdirSync(root, { recursive: true });
const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
const write = (name, value) =>
  fs.writeFileSync(path.join(root, name), JSON.stringify(value, null, 2));
const run = (command, args) => execFileSync(command, args, { encoding: "utf8" }).trim();
const command = process.argv[2];
if (command === "prepare") {
  const sha = run("git", ["rev-parse", "HEAD"]);
  if (sha !== process.env.GITHUB_SHA) throw new Error("Unexpected source revision");
  write("workload.json", {
    sourceSha: sha,
    acceptanceRule: process.env.ACCEPTANCE_RULE,
    samples: 5,
    order: "cold-1,warm-1,cold-2,warm-2,cold-3,warm-3,cold-4,warm-4,cold-5,warm-5",
    flow: "Release generic iOS archive; signing disabled; no export or upload",
    xcode: run("xcodebuild", ["-version"]),
    watchSdk: run("xcrun", ["--sdk", "watchos", "--show-sdk-version"]),
    machine: { cpus: os.availableParallelism(), memory: os.totalmem(), arch: os.arch() },
    packageSourcePolicy:
      "Shared resolved SwiftPM packages and Cargo registry; fresh DerivedData, archive, and RTC output per sample",
  });
} else if (command === "sample") {
  const label = process.argv[3];
  if (!/^(cold|warm)-[1-5]$/.test(label)) throw new Error("Invalid sample");
  if (run("git", ["rev-parse", "HEAD"]) !== read("workload.json").sourceSha)
    throw new Error("Source changed");
  const cold = label.startsWith("cold");
  const cacheTransferMs = cold ? 0 : Date.now() - Number(process.env.CACHE_RESTORE_STARTED_MS);
  if (cold) fs.rmSync(process.env.OPENCLAW_WATCH_RTC_CACHE_DIR, { recursive: true, force: true });
  const derived = path.join(process.env.RUNNER_TEMP, "ios-watch-rtc-archive-products");
  const archive = path.join(process.env.RUNNER_TEMP, "ios-watch-rtc-archive.xcarchive");
  for (const file of [derived, archive]) fs.rmSync(file, { recursive: true, force: true });
  const logPath = path.join(root, label + ".log");
  const fd = fs.openSync(logPath, "w");
  const started = performance.now();
  const result = spawnSync(
    "xcodebuild",
    [
      "-project",
      "apps/ios/OpenClaw.xcodeproj",
      "-scheme",
      "OpenClaw",
      "-configuration",
      "Release",
      "-showBuildTimingSummary",
      "-destination",
      "generic/platform=iOS",
      "-derivedDataPath",
      derived,
      "-clonedSourcePackagesDirPath",
      path.join(process.env.RUNNER_TEMP, "ios-watch-rtc-source-packages"),
      "-archivePath",
      archive,
      "CODE_SIGNING_ALLOWED=NO",
      "CODE_SIGNING_REQUIRED=NO",
      "clean",
      "archive",
    ],
    { stdio: ["ignore", fd, fd], env: process.env, timeout: 45 * 60_000 },
  );
  const archiveMs = performance.now() - started;
  fs.closeSync(fd);
  const log = fs.readFileSync(logPath, "utf8");
  const hits = [...log.matchAll(/Watch RTC: verified cache hit \(([^)]+)\)/g)].map((hit) => hit[1]);
  const cargoBuilds = [...log.matchAll(/Finished [^\n]*profile[^\n]*in [^\n]+/g)].map(
    (entry) => entry[0],
  );
  const expected = ["aarch64-apple-watchos", "arm64_32-apple-watchos"];
  const valid =
    result.status === 0 &&
    (cold
      ? hits.length === 0 && cargoBuilds.length === 2
      : expected.every((target) => hits.includes(target)) && cargoBuilds.length === 0);
  const sample = {
    label,
    archiveMs,
    cacheTransferMs,
    totalMs: archiveMs + cacheTransferMs,
    exitCode: result.status,
    signal: result.signal,
    hits,
    cargoBuilds,
    valid,
  };
  write(label + ".json", sample);
  console.log(JSON.stringify(sample));
  if (!valid) {
    console.log(log.split("\n").slice(-100).join("\n"));
    process.exitCode = 1;
  }
} else if (command === "report") {
  const samples = fs
    .readdirSync(root)
    .filter((name) => /^(cold|warm)-[1-5]\.json$/.test(name))
    .map(read);
  const stats = (values) => {
    const sorted = values.toSorted((a, b) => a - b);
    return {
      n: sorted.length,
      medianMs: sorted[2],
      p95Ms: sorted[4],
      minMs: sorted[0],
      maxMs: sorted[4],
    };
  };
  const group = (prefix, metric) =>
    stats(
      samples.filter((sample) => sample.label.startsWith(prefix)).map((sample) => sample[metric]),
    );
  const cold = group("cold", "totalMs");
  const warm = group("warm", "totalMs");
  const accepted =
    samples.length === 10 &&
    samples.every((sample) => sample.valid) &&
    warm.medianMs <= cold.medianMs * 0.95 &&
    warm.p95Ms < cold.p95Ms * 1.2;
  write("summary.json", {
    workload: read("workload.json"),
    cold,
    warm,
    archiveOnly: { cold: group("cold", "archiveMs"), warm: group("warm", "archiveMs") },
    samples,
    accepted,
  });
  const summary = `Watch RTC archive-only comparison\n\n${JSON.stringify({ cold, warm, accepted }, null, 2)}\n`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  if (!accepted) process.exitCode = 1;
} else {
  throw new Error("Unknown command");
}
