import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as tar from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  composeInstalledRuntime,
  type CompositionOptions,
  verifyInstalledRuntimeComposition,
  resolveInstalledRuntimeImageRecipe,
} from "../../scripts/compose-installed-runtime.mts";
import { verifyInstalledRuntimeImageInputs } from "../../scripts/lib/installed-runtime-image-inputs.mjs";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const runtimeCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repo,
  encoding: "utf8",
}).trim();
const runtimeLock = readFileSync(path.join(repo, "pnpm-lock.yaml"), "utf8");
const owned: string[] = [];
const digest = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
async function write(root: string, relative: string, contents: string) {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
}
async function fixture(
  rootImports?: "present" | "missing",
  promotion?: "present" | "version" | "undeclared" | "transitive-missing",
  foreignLinkMode = false,
) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "installed-composition-")),
  );
  owned.push(root);
  const source = path.join(root, "source");
  const deps = path.join(root, "deps");
  const pack = path.join(root, "package");
  const manifest = {
    name: "openclaw",
    version: "1.0.0",
    type: "module",
    files: [],
    dependencies: { bundled: "1.0.0", external: "1.0.0", left: "1.0.0" },
  };
  const build = { version: "1.0.0", commit: runtimeCommit, buildId: "fixture-a" };
  for (const dir of [source, deps, pack]) {
    await write(dir, "package.json", JSON.stringify(manifest));
  }
  for (const dir of [source, deps]) {
    await write(dir, "pnpm-lock.yaml", runtimeLock);
  }
  await write(source, "dist/build-info.json", JSON.stringify(build));
  await write(source, "Dockerfile", "FROM qualified-fixture\n");
  await write(source, "docker-entrypoint.mjs", 'import "./cli-root-options.mjs";\n');
  // Portable packages omit Docker's lock/entrypoint, but include these public runtime files.
  for (const name of [
    "pnpm-workspace.yaml",
    "node-version.mjs",
    "node-sqlite.mjs",
    "node-runtime-update.mjs",
    "node-runtime-recovery.mjs",
    "cli-parent-lifetime.mjs",
    "node-runtime-env.mjs",
    "cli-invocation.mjs",
    "cli-root-options.mjs",
    "gateway-run-argv.mjs",
    "gateway-shutdown-budget.mjs",
    "node-host-launcher.mjs",
    "node-compile-cache.mjs",
    "openclaw.mjs",
  ]) {
    await write(pack, name, "// portable fixture\n");
  }
  for (const name of ["docs", "skills", "patches"]) {
    await fs.mkdir(path.join(pack, name), { recursive: true });
  }
  await fs.symlink(path.join(repo, "scripts"), path.join(source, "scripts"));
  await fs.symlink(path.join(repo, "src"), path.join(source, "src"));
  await write(
    deps,
    "runtime-input.json",
    JSON.stringify({
      platform: "linux",
      arch: "x64",
      packageJsonSha256: digest(JSON.stringify(manifest)),
      lockfileSha256: digest(runtimeLock),
    }),
  );
  const addPackage = async (where: string, name: string, version: string, dependencies = {}) => {
    await write(
      where,
      "package.json",
      JSON.stringify({ name, version, type: "module", exports: "./index.js", dependencies }),
    );
    await write(where, "index.js", `export default ${JSON.stringify(version)};\n`);
  };
  await addPackage(path.join(pack, "node_modules/bundled"), "bundled", "1.0.0");
  await write(pack, "node_modules/bundled/preserved.txt", "portable owns this\n");
  await addPackage(path.join(deps, "node_modules/bundled"), "bundled", "1.0.0");
  await write(deps, "node_modules/bundled/preserved.txt", "WRONG source workspace\n");
  await addPackage(path.join(deps, "node_modules/external"), "external", "1.0.0", {
    nested: "2.0.0",
  });
  await addPackage(path.join(deps, "node_modules/external/node_modules/nested"), "nested", "2.0.0");
  if (foreignLinkMode) {
    await fs.mkdir(path.join(deps, ".store/node_modules"), { recursive: true });
    await fs.rename(
      path.join(deps, "node_modules/external"),
      path.join(deps, ".store/node_modules/external"),
    );
    await fs.symlink("../.store/node_modules/external", path.join(deps, "node_modules/external"));
    await write(deps, "._authored", "authored input, not generated transport metadata\n");
  }
  await addPackage(path.join(deps, "node_modules/left"), "left", "1.0.0", { nested: "1.0.0" });
  await addPackage(path.join(deps, "node_modules/left/node_modules/nested"), "nested", "1.0.0");
  await addPackage(
    path.join(deps, "extensions/demo/node_modules/private"),
    "private",
    promotion === "version" ? "4.0.0" : "3.0.0",
    promotion ? { nested: "3.0.0" } : {},
  );
  if (promotion) {
    const name = promotion === "undeclared" ? "undeclared" : "private";
    await write(
      pack,
      "package.json",
      JSON.stringify({
        ...manifest,
        dependencies: {
          ...manifest.dependencies,
          [name]: promotion === "undeclared" ? "1.0.0" : "3.0.0",
        },
      }),
    );
    if (promotion !== "transitive-missing") {
      await addPackage(
        path.join(deps, "extensions/demo/node_modules/private/node_modules/nested"),
        "nested",
        "3.0.0",
      );
    }
    await addPackage(
      path.join(deps, "extensions/demo/node_modules/undeclared"),
      "undeclared",
      "1.0.0",
    );
  }
  await write(
    pack,
    "dist/extensions/demo/package.json",
    JSON.stringify({
      name: "demo",
      version: "1.0.0",
      dependencies: { private: "3.0.0" },
      peerDependencies: { openclaw: "*" },
    }),
  );
  await write(pack, "dist/build-info.json", JSON.stringify(build));
  await write(pack, "dist/entry.js", "export const fromPortable = true;\n");
  if (rootImports) {
    await write(pack, "gateway-prewarm.mjs", 'import "./dist/gateway-prewarm.js";\n');
    await write(pack, "node-runtime-update.mjs", 'import "./scripts/windows-cmd-helpers.mjs";\n');
    await write(
      pack,
      "openclaw.mjs",
      'import "./dist/extensions/browser/native-host-entry.js"; import "./dist/infra/package-lifecycle.js";\n',
    );
    for (const target of [
      "dist/gateway-prewarm.js",
      "dist/extensions/browser/native-host-entry.js",
      "dist/infra/package-lifecycle.js",
    ]) {
      await write(pack, target, "export {};\n");
    }
    if (rootImports === "present") {
      await write(pack, "scripts/windows-cmd-helpers.mjs", "export {};\n");
    }
  }
  await tar.create({ cwd: root, file: path.join(root, "portable.tgz"), gzip: true }, ["package"]);
  const archive = await fs.readFile(path.join(root, "portable.tgz"));
  await write(
    root,
    "package-receipt.json",
    JSON.stringify({ sha256: digest(archive), bytes: archive.length, buildInfo: build }),
  );
  // Independent fixed filesystem inventory supplied by the input owner, not the subject.
  const rows: Record<string, unknown>[] = [];
  async function visit(relative = "") {
    const file = path.join(deps, relative);
    const stat = await fs.lstat(file);
    const row: Record<string, unknown> = {
      path: `node-runtime-dependencies/linux-x64${relative ? `/${relative}` : ""}`,
      mode: `0o${(stat.mode & 0o777).toString(8)}`,
      kind: stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "directory" : "file",
    };
    if (stat.isSymbolicLink()) {
      row.target = await fs.readlink(file);
      // Declare the other physical representation, as a cross-OS input producer would.
      row.mode = (stat.mode & 0o777) === 0o755 ? "0o777" : "0o755";
    }
    if (stat.isFile()) {
      const bytes = await fs.readFile(file);
      row.size = bytes.length;
      row.sha256 = digest(bytes);
    }
    rows.push(row);
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(file)).toSorted()) {
        await visit([relative, name].filter(Boolean).join("/"));
      }
    }
  }
  await visit();
  const inventory = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  await write(root, "linux.jsonl", inventory);
  return {
    root,
    deps,
    options: {
      package: path.join(root, "portable.tgz"),
      packageReceipt: path.join(root, "package-receipt.json"),
      dependencyRoot: deps,
      dependencyManifest: path.join(root, "linux.jsonl"),
      dependencyManifestSha256: digest(inventory),
      sourceRoot: source,
      platform: "linux",
      arch: "x64",
      outputDir: path.join(root, "composed"),
    },
  };
}

afterEach(async () => {
  for (const root of owned.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});
describe("offline installed runtime composition", () => {
  it("reuses composition import edges while checking the actual post-prune closure", async () => {
    const { root, options } = await fixture();
    await write(path.join(root, "package"), "dist/entry.js", 'import "./leaf.mjs";\n');
    await write(path.join(root, "package"), "dist/leaf.mjs", "export {};\n");
    await tar.create({ cwd: root, file: options.package, gzip: true }, ["package"]);
    const archive = await fs.readFile(options.package);
    const receipt = JSON.parse(await fs.readFile(options.packageReceipt, "utf8"));
    await fs.writeFile(
      options.packageReceipt,
      JSON.stringify({ ...receipt, sha256: digest(archive), bytes: archive.length }),
    );
    const result = await composeInstalledRuntime(options);
    const app = path.join(options.outputDir, "app");
    const graphPath = path.join(app, ".runtime-bootstrap/package-dist-imports.json");
    expect(JSON.parse(await fs.readFile(graphPath, "utf8"))).toEqual([
      { importerPath: "dist/entry.js", importedPath: "dist/leaf.mjs" },
    ]);
    const rows = (await fs.readFile(result.manifest.path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rows).toContainEqual(
      expect.objectContaining({
        path: "app/.runtime-bootstrap/package-dist-imports.json",
        sha256: digest(await fs.readFile(graphPath)),
      }),
    );
    const check = () =>
      spawnSync(
        process.execPath,
        [path.join(repo, "scripts/check-package-dist-imports.mjs"), app, "--imports", graphPath],
        { encoding: "utf8" },
      );
    expect(check().status).toBe(0);
    await fs.rm(path.join(app, "dist/leaf.mjs"));
    const missing = check();
    expect(missing.status, missing.stderr).toBe(1);
    expect(missing.stderr).toContain("dist/entry.js imports missing dist/leaf.mjs");
    await fs.rm(path.join(app, "dist/entry.js"));
    expect(check().status).toBe(0);
    await fs.rm(graphPath);
    expect(check().status).not.toBe(0);
  });

  it("reuses qualified Linux inputs after relocating unchanged artifacts to the builder", async () => {
    const { root, deps, options } = await fixture();
    const result = await composeInstalledRuntime(options);
    const operation = {
      stage: "canonical-linux-installed-composition",
      status: "passed",
      exitCode: 0,
      runtimeCommit: result.runtime.commit,
      argv: [
        process.execPath,
        "scripts/compose-installed-runtime.mts",
        ...Object.entries(options).flatMap(([name, value]) => [
          `--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
          value,
        ]),
      ],
    };
    const operationPath = path.join(root, "composition.operation.json");
    await fs.writeFile(operationPath, JSON.stringify(operation));
    const moved = path.join(root, "linux-builder");
    await fs.mkdir(moved);
    const movedDeps = path.join(moved, "deps");
    const movedManifest = path.join(moved, "linux.jsonl");
    const movedPrior = path.join(moved, "prior");
    const movedOperation = path.join(moved, "operation.json");
    await fs.rename(deps, movedDeps);
    await fs.rename(options.dependencyManifest, movedManifest);
    await fs.rename(options.outputDir, movedPrior);
    await fs.rename(operationPath, movedOperation);
    const priorReceipt = path.join(movedPrior, "receipt.json");
    const traversal = vi.spyOn(fs, "readdir");
    try {
      const reused = await composeInstalledRuntime({
        ...options,
        dependencyRoot: movedDeps,
        dependencyManifest: movedManifest,
        outputDir: path.join(moved, "new-composition"),
        qualifiedDependencyInput: {
          operation: { path: movedOperation, sha256: digest(await fs.readFile(movedOperation)) },
          receipt: { path: priorReceipt, sha256: digest(await fs.readFile(priorReceipt)) },
        },
      });
      expect(reused.inputs.dependencyManifest.inputVerification.mode).toBe("qualified-reuse");
      expect(
        traversal.mock.calls.filter(([directory]) => String(directory) === movedDeps),
      ).toHaveLength(0);
      expect(
        await fs.readFile(
          path.join(moved, "new-composition/app/node_modules/external/index.js"),
          "utf8",
        ),
      ).toBe('export default "1.0.0";\n');
    } finally {
      traversal.mockRestore();
    }
  });

  it("binds image recipes without rescanning, while explicit verification stays strict", async () => {
    const { options } = await fixture();
    const result = await composeInstalledRuntime(options);
    const receiptPath = path.join(options.outputDir, "receipt.json");
    const receiptBytes = await fs.readFile(receiptPath);
    const verification = {
      compositionRoot: options.outputDir,
      receiptSha256: digest(receiptBytes),
      portablePackageSha256: result.inputs.portablePackage.sha256,
      expectedRuntime: result.runtime,
    };
    const app = path.join(options.outputDir, "app");
    const traversal = vi.spyOn(fs, "readdir");
    try {
      await resolveInstalledRuntimeImageRecipe(verification);
      expect(traversal.mock.calls.filter(([directory]) => String(directory) === app)).toHaveLength(
        0,
      );
      await verifyInstalledRuntimeComposition(verification);
      expect(traversal.mock.calls.filter(([directory]) => String(directory) === app)).toHaveLength(
        1,
      );
    } finally {
      traversal.mockRestore();
    }
    await expect(
      resolveInstalledRuntimeImageRecipe({ ...verification, receiptSha256: "0".repeat(64) }),
    ).rejects.toThrow(/receipt digest/);
    await expect(
      resolveInstalledRuntimeImageRecipe({
        ...verification,
        expectedRuntime: { ...result.runtime, buildId: "stale" },
      }),
    ).rejects.toThrow(/runtime identity/);
    const incomplete = JSON.parse(receiptBytes.toString());
    incomplete.checks.relativeImportClosure = false;
    const incompleteBytes = JSON.stringify(incomplete);
    await fs.writeFile(receiptPath, incompleteBytes);
    await expect(
      resolveInstalledRuntimeImageRecipe({
        ...verification,
        receiptSha256: digest(incompleteBytes),
      }),
    ).rejects.toThrow(/qualification is incomplete/);
    await fs.writeFile(receiptPath, receiptBytes);
    await write(app, "dist/entry.js", "export const changed = true;\n");
    await expect(verifyInstalledRuntimeComposition(verification)).rejects.toThrow(
      /inventory mismatch/,
    );
  });

  it("reuses a successful strict donor qualification without traversing the donor again", async () => {
    const { root, deps, options } = await fixture();
    const argv = ["--import", "./scripts/tsx.mjs", "scripts/compose-installed-runtime.mts"];
    for (const [name, value] of Object.entries(options)) {
      argv.push(`--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, value);
    }
    const qualified = spawnSync(process.execPath, argv, { cwd: repo, encoding: "utf8" });
    expect(qualified.status, qualified.stderr).toBe(0);
    const priorReceipt = path.join(options.outputDir, "receipt.json");
    const operationFile = path.join(root, "composition.operation.json");
    const operation = {
      stage: "canonical-linux-installed-composition",
      status: qualified.status === 0 ? "passed" : "failed",
      exitCode: qualified.status,
      argv: [process.execPath, ...argv],
      runtimeCommit,
    };
    await fs.writeFile(operationFile, JSON.stringify(operation));
    const evidence = {
      operation: { path: operationFile, sha256: digest(await fs.readFile(operationFile)) },
      receipt: { path: priorReceipt, sha256: digest(await fs.readFile(priorReceipt)) },
    };
    const reuse: CompositionOptions = {
      ...options,
      outputDir: path.join(root, "reused"),
      qualifiedDependencyInput: evidence,
    };
    const spy = vi.spyOn(fs, "readdir");
    let result;
    try {
      result = await composeInstalledRuntime(reuse);
      expect(spy.mock.calls.filter(([directory]) => String(directory) === deps)).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
    expect(result.inputs.dependencyManifest.inputVerification).toEqual({
      mode: "qualified-reuse",
      dependencyRoot: deps,
      ...evidence,
    });
    expect(
      await fs.readFile(path.join(reuse.outputDir, "app/node_modules/external/index.js"), "utf8"),
    ).toBe('export default "1.0.0";\n');
    expect(
      await fs.readFile(
        path.join(reuse.outputDir, "app/node_modules/bundled/preserved.txt"),
        "utf8",
      ),
    ).toBe("portable owns this\n");
    const verification = {
      compositionRoot: reuse.outputDir,
      receiptSha256: digest(await fs.readFile(path.join(reuse.outputDir, "receipt.json"))),
      portablePackageSha256: digest(await fs.readFile(options.package)),
      expectedRuntime: result.runtime,
    };
    await expect(verifyInstalledRuntimeComposition(verification)).resolves.toMatchObject({
      lifecycle: { completed: false, status: "target-required" },
    });
    const cliArgs = [...argv];
    cliArgs[cliArgs.indexOf("--output-dir") + 1] = path.join(root, "cli-reused");
    for (const [name, value] of [
      ["qualified-dependency-operation", evidence.operation.path],
      ["qualified-dependency-operation-sha256", evidence.operation.sha256],
      ["qualified-dependency-receipt", evidence.receipt.path],
      ["qualified-dependency-receipt-sha256", evidence.receipt.sha256],
    ] as const) {
      cliArgs.push(`--${name}`, value);
    }
    const cli = spawnSync(process.execPath, cliArgs, { cwd: repo, encoding: "utf8" });
    expect(cli.status, cli.stderr).toBe(0);
    expect(JSON.parse(cli.stdout).inputs.dependencyManifest.inputVerification.mode).toBe(
      "qualified-reuse",
    );
    await expect(composeInstalledRuntime(reuse)).rejects.toThrow(/EEXIST/);
    for (const failure of [
      "digest",
      "failed",
      "origin-output",
      "target",
      "pins",
      "receipt",
      "manifest",
    ] as const) {
      const changedOperation = { ...operation, argv: [...operation.argv] };
      const changedReceipt = JSON.parse(await fs.readFile(priorReceipt, "utf8"));
      if (failure === "failed") {
        changedOperation.exitCode = 1;
      }
      if (failure === "origin-output") {
        changedOperation.argv[changedOperation.argv.indexOf("--output-dir") + 1] = root;
      }
      if (failure === "target") {
        changedReceipt.target.arch = "arm64";
      }
      if (failure === "pins") {
        changedReceipt.inputs.sourceLockSha256 = "0".repeat(64);
      }
      if (failure === "receipt") {
        changedReceipt.checks.inputInventory = false;
      }
      if (failure === "manifest") {
        changedReceipt.inputs.dependencyManifest.sha256 = "0".repeat(64);
      }
      const changedOperationPath = path.join(root, `operation-${failure}.json`);
      const changedReceiptPath = path.join(options.outputDir, `receipt-${failure}.json`);
      await fs.writeFile(changedOperationPath, JSON.stringify(changedOperation));
      await fs.writeFile(changedReceiptPath, JSON.stringify(changedReceipt));
      const rejected = {
        ...reuse,
        outputDir: path.join(root, `rejected-${failure}`),
        qualifiedDependencyInput: {
          operation: {
            path: changedOperationPath,
            sha256:
              failure === "digest"
                ? "0".repeat(64)
                : digest(await fs.readFile(changedOperationPath)),
          },
          receipt: {
            path: changedReceiptPath,
            sha256: digest(await fs.readFile(changedReceiptPath)),
          },
        },
      };
      await expect(composeInstalledRuntime(rejected), failure).rejects.toThrow(
        /Qualified dependency evidence/,
      );
      await expect(fs.access(rejected.outputDir)).rejects.toThrow();
    }
    await write(deps, "node_modules/external/unqualified.js", "unqualified\n");
    await expect(
      composeInstalledRuntime({ ...reuse, outputDir: path.join(root, "unlisted") }),
    ).rejects.toThrow(/Dependency absent from admitted manifest/);
    await write(path.join(reuse.outputDir, "app"), "dist/entry.js", "changed\n");
    await expect(verifyInstalledRuntimeComposition(verification)).rejects.toThrow(
      /inventory mismatch/,
    );
  });
  it("accepts transported symlink permission representation without changing source facts", async () => {
    const { deps, options } = await fixture(undefined, undefined, true);
    const original = await fs.readFile(options.dependencyManifest, "utf8");
    const result = await composeInstalledRuntime(options);
    expect(result.inputs.dependencyManifest.physicalSymlinkModeDifferences).toBe(1);
    expect(await fs.readFile(options.dependencyManifest, "utf8")).toBe(original);
    expect(await fs.readlink(path.join(deps, "node_modules/external"))).toBe(
      "../.store/node_modules/external",
    );
    expect(await fs.readFile(path.join(deps, "._authored"), "utf8")).toBe(
      "authored input, not generated transport metadata\n",
    );
    const installed = path.join(options.outputDir, "app/node_modules/external");
    expect((await fs.lstat(installed)).isDirectory()).toBe(true);
    expect(await fs.readFile(path.join(installed, "index.js"), "utf8")).toBe(
      'export default "1.0.0";\n',
    );
  });
  it.each(["target", "file-mode", "directory-mode", "extra-entry"] as const)(
    "retains strict dependency %s checks with transported symlink metadata",
    async (failure) => {
      const { deps, options } = await fixture(undefined, undefined, true);
      let expected = "Dependency inventory mismatch: node-runtime-dependencies/linux-x64/";
      if (failure === "target") {
        await fs.unlink(path.join(deps, "node_modules/external"));
        await fs.symlink("left", path.join(deps, "node_modules/external"));
        expected += "node_modules/external";
      } else if (failure === "extra-entry") {
        await write(deps, "._transport-extra", "unexpected\n");
        expected = "Dependency inventory entry count mismatch";
      } else {
        const relative =
          ".store/node_modules/external" + (failure === "file-mode" ? "/index.js" : "");
        const file = path.join(deps, relative);
        await fs.chmod(file, (await fs.stat(file)).mode ^ 0o020);
        expected += relative;
      }
      await expect(composeInstalledRuntime(options)).rejects.toThrow(expected);
      await expect(fs.access(path.join(options.outputDir, "receipt.json"))).rejects.toThrow();
    },
  );
  it("preserves portable bundled content and importer-relative versions without source links", async () => {
    const { root, options } = await fixture();
    const result = await composeInstalledRuntime(options);
    const installed = path.join(root, "consumer");
    await fs.mkdir(installed);
    await tar.extract({ file: result.archive.path, cwd: installed });
    const app = path.join(installed, "app");
    expect(await fs.readFile(path.join(app, "node_modules/bundled/preserved.txt"), "utf8")).toBe(
      "portable owns this\n",
    );
    const answer = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {createRequire} from 'node:module'; const r=createRequire(${JSON.stringify(path.join(app, "package.json"))}); const e=r.resolve('external'); const l=r.resolve('left'); console.log(r(r.resolve('nested',{paths:[e]})).default)`,
      ],
      { encoding: "utf8" },
    );
    expect(answer.trim()).toBe("2.0.0");
    const moduleVersion = async (file: string) =>
      JSON.parse(await fs.readFile(file, "utf8")).version;
    expect(
      await moduleVersion(path.join(app, "node_modules/left/node_modules/nested/package.json")),
    ).toBe("1.0.0");
    expect(
      await moduleVersion(path.join(app, "extensions/demo/node_modules/private/package.json")),
    ).toBe("3.0.0");
    expect(await fs.readFile(path.join(app, "dist/entry.js"), "utf8")).toBe(
      "export const fromPortable = true;\n",
    );
    expect(result.runtime.commit).toBe(runtimeCommit);
    expect(result.lifecycle).toMatchObject({ status: "target-required", completed: false });
    await expect(fs.access(path.join(app, ".openclaw-lifecycle-pending"))).resolves.toBeUndefined();
    expect(result.archive.sha256).toBe(digest(await fs.readFile(result.archive.path)));
    const verification = {
      compositionRoot: options.outputDir,
      receiptSha256: digest(await fs.readFile(path.join(options.outputDir, "receipt.json"))),
      portablePackageSha256: digest(await fs.readFile(options.package)),
      expectedRuntime: { version: "1.0.0", commit: runtimeCommit, buildId: "fixture-a" },
    };
    const recipe = await resolveInstalledRuntimeImageRecipe(verification);
    expect(recipe).toMatchObject({
      schema: "openclaw.installed-runtime.image-recipe.v1",
      target: "openclaw-runtime",
      buildArgs: { OPENCLAW_RUNTIME_ASSETS: "installed-runtime-assets" },
      namedContexts: { openclaw_installed_runtime: options.outputDir },
      composition: {
        compositionOnly: true,
        appRoot: path.join(options.outputDir, "app"),
        lifecycle: { completed: false, status: "target-required" },
      },
    });
    expect(recipe.dockerfile.path).toBe(path.join(repo, "Dockerfile"));
    expect(recipe.dockerfile.sha256).toBe(digest(await fs.readFile(path.join(repo, "Dockerfile"))));
    const missingIdentity = spawnSync(
      process.execPath,
      [
        "--import",
        "./scripts/tsx.mjs",
        "scripts/compose-installed-runtime.mts",
        "--operation",
        "verify",
      ],
      { cwd: repo, encoding: "utf8" },
    );
    expect(missingIdentity.status).toBe(1);
    expect(missingIdentity.stdout).toBe("");
    expect(missingIdentity.stderr).toContain("Missing --composition-root");
    const cli = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--import",
          "./scripts/tsx.mjs",
          "scripts/compose-installed-runtime.mts",
          "--operation",
          "verify",
          "--composition-root",
          verification.compositionRoot,
          "--receipt-sha256",
          verification.receiptSha256,
          "--portable-package-sha256",
          verification.portablePackageSha256,
          "--runtime-version",
          "1.0.0",
          "--runtime-commit",
          runtimeCommit,
          "--runtime-build-id",
          "fixture-a",
        ],
        { cwd: repo, encoding: "utf8" },
      ),
    );
    expect(cli).toMatchObject({
      schema: "openclaw.installed-runtime.verification.v1",
      compositionOnly: true,
      runtime: verification.expectedRuntime,
    });
  });
  it.each(["present", "version", "undeclared", "transitive-missing"] as const)(
    "resolves promoted root dependency: %s",
    async (mode) => {
      const { root, options } = await fixture(undefined, mode);
      if (mode !== "present") {
        const error =
          mode === "version"
            ? /dependency identity mismatch: private@3.0.0/
            : mode === "undeclared"
              ? /openclaw requires undeclared/
              : /private requires nested/;
        await expect(composeInstalledRuntime(options)).rejects.toThrow(error);
        await expect(fs.access(path.join(options.outputDir, "receipt.json"))).rejects.toThrow();
        return;
      }
      await composeInstalledRuntime(options);
      const app = path.join(options.outputDir, "app");
      const answer = execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import {createRequire} from 'node:module'; const r=createRequire(${JSON.stringify(path.join(app, "package.json"))}); const p=r.resolve('private'); console.log(r(r.resolve('nested',{paths:[p]})).default); console.log(r('nested').default);`,
        ],
        { encoding: "utf8" },
      );
      expect(answer.trim().split("\n")).toEqual(["3.0.0", "2.0.0"]);
      expect(
        JSON.parse(await fs.readFile(path.join(app, "node_modules/private/package.json"), "utf8"))
          .version,
      ).toBe("3.0.0");
      await expect(fs.access(path.join(app, "node_modules/undeclared"))).rejects.toThrow();
      const manifest = await fs.readFile(
        path.join(options.outputDir, "installed-runtime.manifest.jsonl"),
        "utf8",
      );
      expect(manifest).not.toContain(root);
    },
  );
  it("qualifies Docker-only inputs without modifying the portable composition", async () => {
    const { root, options } = await fixture();
    const result = await composeInstalledRuntime(options);
    const app = path.join(options.outputDir, "app");
    const verification = {
      compositionRoot: options.outputDir,
      receiptSha256: digest(await fs.readFile(path.join(options.outputDir, "receipt.json"))),
      portablePackageSha256: digest(await fs.readFile(options.package)),
      expectedRuntime: result.runtime,
    };
    const verified = await verifyInstalledRuntimeComposition(verification);
    expect(verified.imageAssets).toEqual([
      { path: "pnpm-lock.yaml", sha256: digest(runtimeLock) },
      {
        path: "docker-entrypoint.mjs",
        sha256: digest(await fs.readFile(path.join(repo, "docker-entrypoint.mjs"))),
      },
    ]);
    await expect(fs.access(path.join(app, "pnpm-lock.yaml"))).rejects.toThrow();
    await expect(fs.access(path.join(app, "docker-entrypoint.mjs"))).rejects.toThrow();
    await fs.rm(path.join(app, "pnpm-workspace.yaml"));
    await expect(verifyInstalledRuntimeComposition(verification)).rejects.toThrow(
      /Installed runtime inventory entry count mismatch/,
    );
    await expect(fs.access(path.join(root, "package", "pnpm-lock.yaml"))).rejects.toThrow();
  });
  it.each(["present", "missing"] as const)(
    "checks %s root-to-dist/scripts targets against the full inventory",
    async (mode) => {
      const { options } = await fixture(mode);
      const result = await composeInstalledRuntime(options);
      const input = {
        compositionRoot: options.outputDir,
        receiptSha256: digest(await fs.readFile(path.join(options.outputDir, "receipt.json"))),
        portablePackageSha256: digest(await fs.readFile(options.package)),
        expectedRuntime: result.runtime,
      };
      if (mode === "present") {
        await expect(verifyInstalledRuntimeComposition(input)).resolves.toMatchObject({
          compositionOnly: true,
        });
      } else {
        await expect(verifyInstalledRuntimeComposition(input)).rejects.toThrow(
          /^node-runtime-update.mjs imports missing scripts\/windows-cmd-helpers.mjs$/,
        );
      }
    },
  );
  it("refuses mismatched or missing native Docker source inputs", async () => {
    const { root, options } = await fixture();
    await composeInstalledRuntime(options);
    const tools = path.join(root, "tools");
    execFileSync("git", ["clone", "--shared", "--no-checkout", "--quiet", repo, tools]);
    for (const name of ["Dockerfile", "pnpm-lock.yaml", "docker-entrypoint.mjs"]) {
      await fs.copyFile(path.join(repo, name), path.join(tools, name));
    }
    const input = {
      appRoot: path.join(options.outputDir, "app"),
      nativeToolRoot: tools,
      runtimeCommit,
      sourceLockSha256: digest(runtimeLock),
      availableFiles: [],
    };
    await write(tools, "pnpm-lock.yaml", "wrong lock\n");
    await expect(verifyInstalledRuntimeImageInputs(input)).rejects.toThrow(
      /source lock identity mismatch/,
    );
    await fs.copyFile(path.join(repo, "pnpm-lock.yaml"), path.join(tools, "pnpm-lock.yaml"));
    await fs.appendFile(path.join(tools, "docker-entrypoint.mjs"), "// changed\n");
    await expect(verifyInstalledRuntimeImageInputs(input)).rejects.toThrow(
      /entrypoint differs from original runtime commit/,
    );
    await fs.rm(path.join(tools, "docker-entrypoint.mjs"));
    await expect(verifyInstalledRuntimeImageInputs(input)).rejects.toThrow(/ENOENT/);
  });
  it.each(["receipt", "package", "runtime", "archive", "manifest", "content", "mode", "link"])(
    "refuses changed %s at installed-output consumption",
    async (failure) => {
      const { root, options } = await fixture();
      await composeInstalledRuntime(options);
      const verification = {
        compositionRoot: options.outputDir,
        receiptSha256: digest(await fs.readFile(path.join(options.outputDir, "receipt.json"))),
        portablePackageSha256: digest(await fs.readFile(options.package)),
        expectedRuntime: { version: "1.0.0", commit: runtimeCommit, buildId: "fixture-a" },
      };
      const app = path.join(options.outputDir, "app");
      if (failure === "receipt") {
        await fs.appendFile(path.join(options.outputDir, "receipt.json"), " ");
      }
      if (failure === "package") {
        verification.portablePackageSha256 = "0".repeat(64);
      }
      if (failure === "runtime") {
        verification.expectedRuntime.buildId = "stale";
      }
      if (failure === "archive") {
        await fs.appendFile(path.join(options.outputDir, "installed-runtime.tgz"), "tamper");
      }
      if (failure === "manifest") {
        await fs.appendFile(path.join(options.outputDir, "installed-runtime.manifest.jsonl"), "\n");
      }
      if (failure === "content") {
        await write(app, "dist/entry.js", "export const changed = true;\n");
      }
      if (failure === "mode") {
        const file = path.join(app, "dist/entry.js");
        await fs.chmod(file, (await fs.stat(file)).mode ^ 0o100);
      }
      if (failure === "link") {
        await fs.symlink(root, path.join(app, "escape"));
      }
      await expect(verifyInstalledRuntimeComposition(verification)).rejects.toThrow(
        failure === "receipt"
          ? /receipt digest/
          : failure === "package"
            ? /composition identity/
            : failure === "runtime"
              ? /runtime identity/
              : ["archive", "manifest"].includes(failure)
                ? /archive\/manifest identity/
                : failure === "link"
                  ? /Unsafe dependency link/
                  : /inventory mismatch/,
      );
    },
  );
  it.each(["portable", "inventory", "identity", "target", "overlap", "escape"])(
    "rejects %s mismatches before publishing a receipt",
    async (failure) => {
      const { root, deps, options } = await fixture();
      if (failure === "portable") {
        await fs.appendFile(options.package, "tamper");
      }
      if (failure === "inventory") {
        await write(deps, "node_modules/external/index.js", "changed\n");
      }
      if (failure === "identity") {
        await write(options.sourceRoot, "pnpm-lock.yaml", "different\n");
      }
      if (failure === "target") {
        options.arch = "arm64";
      }
      if (failure === "overlap") {
        options.outputDir = path.join(deps, "output");
      }
      if (failure === "escape") {
        await fs.symlink(root, path.join(deps, "escape"));
      }
      await expect(composeInstalledRuntime(options)).rejects.toThrow();
      await expect(fs.access(path.join(options.outputDir, "receipt.json"))).rejects.toThrow();
    },
  );
});
