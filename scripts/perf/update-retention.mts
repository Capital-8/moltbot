/** Synthetic installed-runtime retention, with exit-only CPU accounting and no SQL observer.
 * Run with: node --import ./scripts/tsx.mjs scripts/perf/update-retention.mts <fixture-root> <result.json> [packages=312]
 * Reuse the fixture root across arms; every invocation creates and removes its own retained tree.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [fixtureRoot, output, packageCount = "312"] = process.argv.slice(2);
if (!fixtureRoot || !output) {
  throw new Error("Expected fixture root, result JSON, and optional package count");
}
const packages = Number(packageCount);
if (!Number.isInteger(packages) || packages < 1) {
  throw new Error("Package count must be a positive integer");
}
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = path.resolve(fixtureRoot, "installed/node_modules/openclaw");
const privateRoot = path.resolve(fixtureRoot, "retained");
const manifest = path.resolve(fixtureRoot, "fixture.json");
try {
  const existing = JSON.parse(await fs.readFile(manifest, "utf8"));
  if (existing.packages !== packages) {
    throw new Error("Existing fixture has a different package count");
  }
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
    throw error;
  }
  await fs.mkdir(path.join(source, "dist"), { recursive: true });
  await fs.writeFile(
    path.join(source, "package.json"),
    JSON.stringify({ name: "openclaw", type: "module", version: "0.0.0" }),
  );
  await fs.writeFile(path.join(source, "dist/index.mjs"), "export const synthetic = true;\n");
  for (let index = 0; index < packages; index++) {
    const owner = path.join(source, "node_modules", `synthetic-${index}`);
    const leaves = path.join(owner, "dist/generated");
    await fs.mkdir(leaves, { recursive: true });
    await fs.writeFile(
      path.join(owner, "package.json"),
      JSON.stringify({ name: `synthetic-${index}`, type: "module", version: "0.0.0" }),
    );
    await fs.writeFile(path.join(owner, "index.mjs"), `export const value = ${index};\n`);
    for (let file = 0; file < 512; file++) {
      await fs.writeFile(
        path.join(leaves, `${file.toString().padStart(4, "0")}.bin`),
        Buffer.alloc(1024, file % 251),
      );
    }
  }
  await fs.writeFile(manifest, JSON.stringify({ packages }));
}
await fs.mkdir(privateRoot); // Refuse another in-progress or uncleaned run.
const cpuMarker = "UPDSTAGE_CPU ";
const collector = `import { isMainThread } from 'node:worker_threads'; import { writeSync } from 'node:fs';
if (isMainThread) process.once('exit', () => writeSync(2, ${JSON.stringify(cpuMarker)} + JSON.stringify({process:process.cpuUsage(),mainThread:process.threadCpuUsage(),resource:process.resourceUsage()}) + '\\n'));`;
const env: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_DISABLE_COMPILE_CACHE: "1",
  NODE_OPTIONS: `${process.env.RETAINCLONE_OBSERVER_OPTIONS ?? ""} --import=${new URL(`data:text/javascript,${encodeURIComponent(collector)}`).href}`,
};
if (!process.env.RETAINCLONE_OBSERVER_OPTIONS) {
  delete env.SQLMEASURE_OUT;
}
const started = performance.now();
let cleanupWallMs = 0;
try {
  const child = spawn(
    process.execPath,
    [
      ...(process.env.RETAINCLONE_CPU_PROFILE_DIR
        ? ["--cpu-prof", `--cpu-prof-dir=${process.env.RETAINCLONE_CPU_PROFILE_DIR}`]
        : []),
      "--import",
      path.join(repo, "scripts/tsx.mjs"),
      path.join(repo, "src/infra/update-candidate-state.worker.ts"),
    ],
    { cwd: repo, env, stdio: ["pipe", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(
    JSON.stringify({
      mode: "runtime-retention",
      sourceRoot: source,
      privateRoot,
      roots: [
        path.join(source, "package.json"),
        path.join(source, "dist"),
        path.join(source, "node_modules"),
      ],
      retainedDependencyRoot: source,
    }),
  );
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const helperWallMs = performance.now() - started;
  if (code !== 0) {
    throw new Error(`Retention helper exited ${code}: ${stderr}`);
  }
  const result = JSON.parse(stdout);
  const cpuLine = stderr.split("\n").find((line) => line.startsWith(cpuMarker));
  if (!cpuLine || result.unusableReason) {
    throw new Error(`Missing successful retention/CPU result: ${stderr}`);
  }
  const { relocations, ...retention } = result;
  await fs.writeFile(
    output,
    JSON.stringify(
      {
        packages,
        files: packages * 514 + 2,
        payloadBytes: packages * 512 * 1024,
        helperWallMs,
        retentionWallMs: result.inventoryMs + result.materializationMs,
        retention,
        relocationCount: relocations.length,
        cpu: JSON.parse(cpuLine.slice(cpuMarker.length)),
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  const cleanupStarted = performance.now();
  await fs.rm(privateRoot, { recursive: true, force: true });
  cleanupWallMs = performance.now() - cleanupStarted;
}
const helperAndCleanupWallMs = performance.now() - started;
const result = JSON.parse(await fs.readFile(output, "utf8"));
result.cleanupWallMs = cleanupWallMs;
result.helperAndCleanupWallMs = helperAndCleanupWallMs;
await fs.writeFile(output, JSON.stringify(result, null, 2) + "\n");
