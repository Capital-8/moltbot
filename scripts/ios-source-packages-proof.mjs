#!/usr/bin/env node
// Nonpublishing hosted-runner proof. The workflow resets task-owned package caches before each sample.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

const [command, mode, sampleNumber] = process.argv.slice(2);
if (
  process.platform !== "darwin" ||
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.RUNNER_ENVIRONMENT !== "github-hosted"
) {
  throw new Error("Run this proof only on its task-owned GitHub-hosted macOS runner.");
}
if (!process.env.RUNNER_TEMP) throw new Error("RUNNER_TEMP is required.");
const directory = path.join(process.env.RUNNER_TEMP, "ios-source-packages-proof");
const source = path.join(process.env.RUNNER_TEMP, "ios-release-recovery/source");
const project = path.join(source, "apps/ios/OpenClaw.xcodeproj");
const contextPath = path.join(directory, "context.json");
const samplesPath = path.join(directory, "samples.json");
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const write = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const run = (executable, args) =>
  execFileSync(executable, args, { cwd: source, encoding: "utf8" }).trim();
const args = [
  "-project",
  project,
  "-scheme",
  "OpenClaw",
  "-configuration",
  "Release",
  "-destination",
  "generic/platform=iOS",
  "-resolvePackageDependencies",
];
const identity = () => ({
  sourceSha: run("git", ["rev-parse", "HEAD"]),
  xcode: run("xcodebuild", ["-version"]),
  project,
});
const host = () => ({
  model: os.cpus()[0].model,
  cpuCount: os.cpus().length,
  memoryBytes: os.totalmem(),
  freeMemoryBytes: os.freemem(),
  loadAverage: os.loadavg(),
  release: os.release(),
  arch: os.arch(),
});

function packageEvidence() {
  const derived = path.join(os.homedir(), "Library/Developer/Xcode/DerivedData");
  const roots = fs
    .readdirSync(derived)
    .filter((name) => name.startsWith("OpenClaw-"))
    .map((name) => path.join(derived, name, "SourcePackages"))
    .filter((root) => fs.existsSync(path.join(root, "workspace-state.json")));
  if (roots.length !== 1)
    throw new Error(
      `Expected one task-owned default OpenClaw SourcePackages root; found ${roots.length}.`,
    );
  const root = roots[0];
  const state = read(path.join(root, "workspace-state.json"));
  const resolved = read(
    path.join(project, "project.xcworkspace/xcshareddata/swiftpm/Package.resolved"),
  );
  const pins = resolved.pins
    .map(({ identity: name, kind, location, state: pin }) => ({ name, kind, location, state: pin }))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!pins.length) throw new Error("Package resolution produced no pinned packages.");
  const artifacts = state.object.artifacts
    .map((artifact) => {
      const artifactPath = path.isAbsolute(artifact.path)
        ? artifact.path
        : path.join(root, artifact.path);
      if (!fs.statSync(artifactPath).isDirectory() || !fs.readdirSync(artifactPath).length)
        throw new Error(`Missing binary artifact: ${artifactPath}`);
      if (artifactPath.endsWith(".xcframework")) {
        const info = JSON.parse(
          run("plutil", ["-convert", "json", "-o", "-", path.join(artifactPath, "Info.plist")]),
        );
        if (!info.AvailableLibraries.length) throw new Error(`Empty xcframework: ${artifactPath}`);
        for (const library of info.AvailableLibraries) {
          let binary = path.join(artifactPath, library.LibraryIdentifier, library.LibraryPath);
          if (binary.endsWith(".framework"))
            binary = path.join(binary, path.basename(binary, ".framework"));
          if (!fs.statSync(binary).size) throw new Error(`Missing artifact slice: ${binary}`);
        }
      }
      return {
        package: artifact.packageRef.identity,
        target: artifact.targetName,
        source: artifact.source,
        path: path.relative(root, artifactPath),
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  if (!artifacts.some((artifact) => artifact.path.endsWith("WebRTC.xcframework")))
    throw new Error("Resolved WebRTC binary artifact is missing.");
  return { sourcePackages: root, pins, artifacts };
}

if (command === "prepare") {
  if (!fs.statSync(project).isDirectory())
    throw new Error(`Generate the canonical release project first: ${project}`);
  fs.mkdirSync(directory, { recursive: true });
  const current = identity();
  if (fs.existsSync(contextPath)) {
    const previous = read(contextPath);
    if (JSON.stringify(previous.identity) !== JSON.stringify(current))
      throw new Error("Proof source/Xcode changed; use a fresh task-owned runner.");
  } else {
    write(contextPath, {
      identity: current,
      host: host(),
      startedAt: new Date().toISOString(),
      command: ["xcodebuild", ...args],
      acceptance:
        "Five cold/warm pairs in order; warm resolve + cache transfer median <= 80% of cold median; warm p95(max of five) <= cold p95; identical pinned packages and complete binary artifacts.",
    });
    write(samplesPath, []);
  }
  console.log(JSON.stringify(read(contextPath), null, 2));
} else if (command === "sample") {
  const context = read(contextPath);
  if (JSON.stringify(identity()) !== JSON.stringify(context.identity))
    throw new Error("Proof source/Xcode changed.");
  const samples = read(samplesPath);
  const number = Number(sampleNumber);
  if (
    !["cold", "warm"].includes(mode) ||
    number !== Math.floor(samples.length / 2) + 1 ||
    number > 5 ||
    mode !== (samples.length % 2 ? "warm" : "cold")
  ) {
    throw new Error("Run exactly: sample cold 1, sample warm 1, ... sample cold 5, sample warm 5.");
  }
  const transfer =
    mode === "warm" ? Number(process.env.OPENCLAW_IOS_SOURCE_PACKAGES_CACHE_SECONDS) : 0;
  if (!Number.isFinite(transfer) || transfer < 0)
    throw new Error(
      "Warm samples require OPENCLAW_IOS_SOURCE_PACKAGES_CACHE_SECONDS (restore wall seconds).",
    );
  const logPath = path.join(directory, `${number}-${mode}.log`);
  const fd = fs.openSync(logPath, "wx");
  const before = host();
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const result = spawnSync("xcodebuild", args, { cwd: source, stdio: ["ignore", fd, fd] });
  const seconds = (performance.now() - start) / 1000;
  fs.closeSync(fd);
  const log = fs.readFileSync(logPath, "utf8");
  const count = (pattern) => [...log.matchAll(pattern)].length;
  const sample = {
    number,
    mode,
    startedAt,
    seconds,
    cacheTransferSeconds: transfer,
    totalSeconds: seconds + transfer,
    hostBefore: before,
    hostAfter: host(),
    status: result.status,
    error: result.error?.message,
    logPath,
    work: {
      fetches: count(/^Fetching from /gm),
      cachedFetches: count(/^Fetching from .*\(cached\)/gm),
      downloads: count(/^Downloading /gm),
      workingCopies: count(/^Creating working copy /gm),
      checkouts: count(/^Checking out /gm),
    },
  };
  try {
    if (result.error || result.status !== 0)
      throw new Error(`xcodebuild resolution failed; inspect ${logPath}`);
    sample.packages = packageEvidence();
  } catch (error) {
    sample.error = error.message;
  }
  samples.push(sample);
  write(samplesPath, samples);
  console.log(JSON.stringify(sample, null, 2));
  if (sample.error) throw new Error(sample.error);
} else if (command === "report") {
  const samples = read(samplesPath);
  if (samples.length !== 10 || samples.some((sample) => sample.error || sample.status !== 0))
    throw new Error("Report requires ten successful interleaved samples.");
  const reference = JSON.stringify({
    pins: samples[0].packages.pins,
    artifacts: samples[0].packages.artifacts,
  });
  if (
    samples.some(
      (sample) =>
        JSON.stringify({ pins: sample.packages.pins, artifacts: sample.packages.artifacts }) !==
        reference,
    )
  )
    throw new Error("Resolved package/artifact identities differ between samples.");
  const stats = (mode) => {
    const values = samples
      .filter((sample) => sample.mode === mode)
      .map((sample) => sample.totalSeconds)
      .sort((a, b) => a - b);
    return { median: values[2], p95: values[4], min: values[0], max: values[4] };
  };
  const cold = stats("cold");
  const warm = stats("warm");
  const passed = warm.median <= cold.median * 0.8 && warm.p95 <= cold.p95;
  const report = {
    context: read(contextPath),
    cold,
    warm,
    medianImprovement: 1 - warm.median / cold.median,
    identicalPackages: true,
    completeArtifacts: true,
    passed,
    samples,
  };
  write(path.join(directory, "report.json"), report);
  const table = [
    "| Pair | Mode | Resolve s | Restore s | Total s | Fetch | Download |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
    ...samples.map(
      (sample) =>
        `| ${sample.number} | ${sample.mode} | ${sample.seconds.toFixed(3)} | ${sample.cacheTransferSeconds.toFixed(3)} | ${sample.totalSeconds.toFixed(3)} | ${sample.work.fetches} | ${sample.work.downloads} |`,
    ),
    "",
    `Cold: ${JSON.stringify(cold)}; warm including restore: ${JSON.stringify(warm)}.`,
    `Median improvement: ${(report.medianImprovement * 100).toFixed(1)}%. p95 is the maximum of five samples.`,
    `Package/artifact identities match; all recorded artifacts exist. Acceptance: ${passed ? "PASS" : "FAIL"}.`,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(directory, "report.md"), table);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, table);
  console.log(table);
  if (!passed) process.exitCode = 1;
} else {
  throw new Error("Usage: ios-source-packages-proof.mjs prepare | sample cold|warm 1..5 | report");
}
