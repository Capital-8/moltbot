#!/usr/bin/env node
// Diagnostic branch only: actual Git and release CLI, with fixed external planning I/O.
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const sourceSha = "642e1749d549d37e94f75eae89317db006f084b4";
const repository = "https://github.com/openclaw/openclaw.git";
const helper = fileURLToPath(import.meta.url);
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const write = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const append = (file, value) => fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
const pendingBuild = {
  id: "synthetic-pending-build",
  shortVersion: "2026.10.90",
  buildNumber: "1",
  configured: true,
  externalState: "WAITING_FOR_BETA_REVIEW",
};
const plan = {
  destination: "testflight",
  gatewayVersion: "2026.10.9",
  appStoreVersion: pendingBuild.shortVersion,
  appStoreRevision: 0,
  buildNumber: 2,
  buildUploads: [],
  testflight: { groupId: "synthetic-external-group", builds: [], pendingBuild },
};

function installPreload() {
  const { PROOF_CHECKOUT: checkout, PROOF_RECOVERY: recovery, PROOF_AUDIT: audit } = process.env;
  if (!checkout || !recovery || !audit) {
    throw new Error("Missing proof subprocess boundaries.");
  }
  const source = path.join(recovery, "source");
  const realExec = childProcess.execFileSync;
  const matches = (args, expected) => JSON.stringify(args) === JSON.stringify(expected);
  const gitAllowed = (args, cwd) =>
    cwd === checkout &&
    ([
      ["rev-parse", "--show-toplevel"],
      ["rev-parse", "HEAD"],
      ["rev-parse", "FETCH_HEAD"],
      ["rev-parse", "--is-shallow-repository"],
      ["status", "--porcelain", "--untracked-files=all"],
      ["fetch", "--no-tags", "origin", "refs/heads/main"],
      ["fetch", "--no-tags", "--filter=blob:none", "--unshallow", "origin", sourceSha],
      ["ls-files", "package.json", "**/package.json"],
      ["ls-remote", "--refs", "origin", "refs/openclaw/mobile-releases/ios/*"],
      ["worktree", "add", "--detach", source, sourceSha],
      ["worktree", "remove", "--force", source],
    ].some((expected) => matches(args, expected)) ||
      (args.length === 4 &&
        matches(args.slice(0, 3), ["merge-base", "--is-ancestor", sourceSha]) &&
        /^[0-9a-f]{40}$/.test(args[3])));
  childProcess.execFileSync = (command, args, options = {}) => {
    const started = performance.now();
    const cwd = path.resolve(options.cwd ?? process.cwd());
    const event = { command, args, cwd };
    try {
      if (options.shell) {
        throw new Error("Shell subprocesses are forbidden.");
      }
      if (
        command === "/bin/bash" &&
        cwd === source &&
        matches(args, ["scripts/ios-release-plan.sh", "--json", "--destination", "testflight"])
      ) {
        event.substitutedPlanner = true;
        return `${JSON.stringify(plan)}\n`;
      }
      if (command !== "git" || !gitAllowed(args, cwd)) {
        event.blocked = true;
        throw new Error(`Forbidden proof subprocess: ${command} ${JSON.stringify(args)}`);
      }
      return realExec(command, args, options);
    } catch (error) {
      event.error = error.message;
      throw error;
    } finally {
      append(audit, { ...event, seconds: (performance.now() - started) / 1000 });
    }
  };
  for (const name of ["exec", "execSync", "execFile", "spawn", "spawnSync", "fork"]) {
    childProcess[name] = () => {
      append(audit, { blocked: true, api: name });
      throw new Error(`Forbidden proof subprocess API: ${name}`);
    };
  }
  process.once("exit", () => append(audit, { cliResourceUsage: process.resourceUsage() }));
  syncBuiltinESMExports();
}

function host() {
  return {
    cpuCount: os.cpus().length,
    cpuModel: os.cpus()[0].model,
    cpuTimes: os.cpus().map((cpu) => cpu.times),
    memoryBytes: os.totalmem(),
    freeMemoryBytes: os.freemem(),
    loadAverage: os.loadavg(),
    arch: os.arch(),
    osRelease: os.release(),
  };
}

function benchmark() {
  if (
    process.platform !== "darwin" ||
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    !process.env.RUNNER_TEMP ||
    !/^[0-9a-f]{40}$/.test(process.env.CANDIDATE_SHA ?? "")
  ) {
    throw new Error(
      "Use the secretless hosted macOS diagnostic workflow with a full candidate SHA.",
    );
  }
  const directory = path.join(process.env.RUNNER_TEMP, "mobile-release-history-proof");
  fs.mkdirSync(directory); // Existing samples must never be silently reused.
  const evidence = path.join(directory, "evidence");
  fs.mkdirSync(evidence);
  const tooling = path.resolve("candidate");
  const env = {
    PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${path.dirname(process.execPath)}`,
    HOME: os.homedir(),
    TMPDIR: os.tmpdir(),
    LANG: "en_US.UTF-8",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/dev/null",
  };
  const run = (args, cwd, audit, log, extraEnv = {}) => {
    const started = performance.now();
    let error;
    try {
      return childProcess
        .execFileSync("git", args, {
          cwd,
          env: { ...env, ...extraEnv },
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
          stdio: ["ignore", "pipe", log],
        })
        .trim();
    } catch (failure) {
      error = failure.message;
      throw failure;
    } finally {
      if (audit) {
        append(audit, {
          command: "git",
          args,
          cwd,
          seconds: (performance.now() - started) / 1000,
          error,
        });
      }
    }
  };
  const candidateSha = run(["rev-parse", "HEAD"], tooling, null, "inherit");
  if (candidateSha !== process.env.CANDIDATE_SHA) {
    throw new Error("Candidate tooling SHA mismatch.");
  }
  const report = {
    sourceSha,
    candidateSha,
    candidateTree: run(["rev-parse", "HEAD^{tree}"], tooling, null, "inherit"),
    command: [
      "node",
      "--import",
      helper,
      "candidate/scripts/mobile-release.mjs",
      "run",
      "--platform",
      "ios",
      "--destination",
      "testflight",
    ],
    acceptance:
      "Five serial baseline/candidate pairs. Complete checkout + preflight median improves >=20%; p95 (max of five) regresses <20%; candidate has zero full-history fetches; same source/tree/deferred outcome; baseline nonshallow and candidate shallow.",
    limits:
      "Real public Git and actual candidate CLI no-op with fixed external planning I/O. Excludes Apple authentication, full tool setup, signing, export, model calls, upload and productive release timing. Dependencies installed once outside measurement. Host CPU counters are shared, and CLI resource usage excludes child Git processes.",
    host: host(),
    samples: [],
  };
  write(path.join(evidence, "report.json"), report);
  try {
    for (let pair = 1; pair <= 5; pair++) {
      for (const mode of ["baseline", "candidate"]) {
        const name = `${pair}-${mode}`;
        const checkout = path.join(directory, name);
        const recovery = path.join(directory, `${name}-recovery`);
        const audit = path.join(evidence, `${name}.jsonl`);
        const trace = path.join(evidence, `${name}-git-trace.jsonl`);
        const log = fs.openSync(path.join(evidence, `${name}.log`), "w");
        const sample = { pair, mode, hostBefore: host() };
        report.samples.push(sample);
        fs.mkdirSync(checkout);
        const sampleEnv = { GIT_TRACE2_EVENT: trace };
        const git = (...args) => run(args, checkout, audit, log, sampleEnv);
        const started = performance.now();
        try {
          git("init", "--quiet");
          git("remote", "add", "origin", repository);
          git("config", "remote.origin.promisor", "true");
          git("config", "remote.origin.partialclonefilter", "blob:none");
          git("fetch", "--no-tags", "--filter=blob:none", "--depth=1", "origin", sourceSha);
          git("checkout", "--quiet", "--detach", "FETCH_HEAD");
          sample.checkoutSeconds = (performance.now() - started) / 1000;
          const hydrationStarted = performance.now();
          if (mode === "baseline") {
            git(
              "fetch",
              "--no-tags",
              "--filter=blob:none",
              "--unshallow",
              "origin",
              `+${sourceSha}:refs/remotes/origin/main`,
            );
          }
          sample.upfrontHistorySeconds = (performance.now() - hydrationStarted) / 1000;
          const cliStarted = performance.now();
          const cli = childProcess.spawnSync(
            process.execPath,
            [
              "--import",
              helper,
              path.join(tooling, "scripts/mobile-release.mjs"),
              "run",
              "--platform",
              "ios",
              "--destination",
              "testflight",
              "--recovery-dir",
              recovery,
            ],
            {
              cwd: checkout,
              env: {
                ...env,
                ...sampleEnv,
                GITHUB_ACTIONS: "true",
                GITHUB_RUN_ATTEMPT: "1",
                GITHUB_EVENT_NAME: "workflow_dispatch",
                GITHUB_REPOSITORY: "openclaw/openclaw",
                GITHUB_REF: "refs/heads/main",
                GITHUB_SHA: sourceSha,
                PROOF_CHECKOUT: checkout,
                PROOF_RECOVERY: recovery,
                PROOF_AUDIT: audit,
              },
              stdio: ["ignore", log, log],
            },
          );
          sample.cliSeconds = (performance.now() - cliStarted) / 1000;
          sample.completeSeconds = (performance.now() - started) / 1000;
          if (cli.error || cli.status !== 0) {
            throw cli.error ?? new Error(`CLI exited ${cli.status}`);
          }
          sample.head = git("rev-parse", "HEAD");
          sample.tree = git("rev-parse", "HEAD^{tree}");
          sample.shallow = git("rev-parse", "--is-shallow-repository") === "true";
          sample.objectStorage = git("count-objects", "-v");
          sample.result = read(path.join(recovery, "testflight-result.json"));
          write(path.join(evidence, `${name}-result.json`), sample.result);
          const events = fs.readFileSync(audit, "utf8").trim().split("\n").map(JSON.parse);
          sample.fullHistoryFetches = events.filter(
            (event) =>
              event.command === "git" &&
              event.args[0] === "fetch" &&
              event.args.includes("--unshallow"),
          ).length;
          sample.plannerSubstitutions = events.filter((event) => event.substitutedPlanner).length;
          sample.cliResourceUsage = events.find(
            (event) => event.cliResourceUsage,
          )?.cliResourceUsage;
          if (
            sample.head !== sourceSha ||
            sample.shallow !== (mode === "candidate") ||
            sample.fullHistoryFetches !== (mode === "baseline" ? 1 : 0) ||
            sample.plannerSubstitutions !== 1 ||
            events.some((event) => event.blocked) ||
            sample.result.outcome !== "deferred-review" ||
            sample.result.sourceSha !== sourceSha ||
            JSON.stringify(sample.result.build) !== JSON.stringify(pendingBuild)
          ) {
            throw new Error("Source, shallow state, subprocess audit or deferred outcome differs.");
          }
        } catch (error) {
          sample.error = error.message;
          sample.failedBoundarySeconds = (performance.now() - started) / 1000;
          throw error;
        } finally {
          fs.closeSync(log);
          sample.hostAfter = host();
          write(path.join(evidence, "report.json"), report);
          console.log(JSON.stringify(sample));
        }
      }
    }
    if (new Set(report.samples.map((sample) => sample.tree)).size !== 1) {
      throw new Error("Sample source trees differ.");
    }
    const stats = (mode) => {
      const seconds = report.samples
        .filter((sample) => sample.mode === mode)
        .map((sample) => sample.completeSeconds)
        .toSorted((a, b) => a - b);
      return { medianSeconds: seconds[2], p95Seconds: seconds[4] };
    };
    report.baseline = stats("baseline");
    report.candidate = stats("candidate");
    report.medianImprovement = 1 - report.candidate.medianSeconds / report.baseline.medianSeconds;
    report.p95Regression = report.candidate.p95Seconds / report.baseline.p95Seconds - 1;
    if (report.medianImprovement < 0.2 || report.p95Regression >= 0.2) {
      throw new Error("Predeclared complete-boundary performance acceptance failed.");
    }
    report.passed = true;
  } catch (error) {
    report.passed = false;
    report.error = error.message;
    process.exitCode = 1;
  } finally {
    write(path.join(evidence, "report.json"), report);
    const summary = `Nonpublishing mobile history proof: ${report.passed ? "PASS" : "FAIL"}\n\n\`\`\`json\n${JSON.stringify({ sourceSha, candidateSha, baseline: report.baseline, candidate: report.candidate, medianImprovement: report.medianImprovement, p95Regression: report.p95Regression, error: report.error, limits: report.limits }, null, 2)}\n\`\`\`\n`;
    if (process.env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
    }
    console.log(summary);
  }
}

if (process.env.PROOF_CHECKOUT) {
  installPreload();
} else {
  benchmark();
}
