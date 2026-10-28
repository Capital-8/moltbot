import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";
import * as tar from "tar";
import { describe, expect, it, vi } from "vitest";
import { collectPackageDistInventory } from "../../infra/package-dist-inventory.js";
import * as tmpDirs from "../../infra/tmp-openclaw-dir.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { NodeBootstrapArtifactWorkerTasks } from "./node-bootstrap-artifact-contract.js";
import {
  buildId,
  expectFiles,
  expectMissing,
  extract,
  longEntryPath,
  longEntryPayload,
  readText,
  useNodeBootstrapArtifactFixtures,
  version,
  write,
  writeBundledBrowser,
  writeFiles,
  writeOwnedChunks,
  type OwnedRuntimeChunk,
} from "./node-bootstrap-artifact.test-support.js";

// mock-isolation: keep byte/race fault injection beside the builder; the worker suite covers transport.
vi.mock("./node-bootstrap-artifact-worker.js", async () => {
  const { prepareNodeBootstrapArtifact } = await import("./node-bootstrap-artifact-build.js");
  return {
    prepareNodeArtifactInWorker: (
      _kind: "bootstrap",
      { options, temporaryRoot }: NodeBootstrapArtifactWorkerTasks["bootstrap"]["input"],
    ) => prepareNodeBootstrapArtifact(options, temporaryRoot),
  };
});

const { fixture, createProvider, tempDirs } = useNodeBootstrapArtifactFixtures();

async function runNode(root: string, entry = "openclaw.mjs") {
  const { stdout } = await promisify(execFile)(process.execPath, [path.join(root, entry)]);
  return stdout.trim();
}

describe("node bootstrap distribution", () => {
  it.each([false, true])(
    "omits unselected plugin chunks while preserving selected imports (selected: %s)",
    async (selected) => {
      const { packageRoot, options, sourcePackage } = await fixture();
      await write(packageRoot, "package.json", {
        ...sourcePackage,
        files: [...sourcePackage.files, "!dist/extensions/omitted-plugin/**"],
      });
      await write(packageRoot, "dist/extensions/omitted-plugin/index.js", "export {};\n");
      await writeOwnedChunks(packageRoot, {
        "omitted-owned.mjs": {
          source: 'import "./extensions/omitted-plugin/index.js";\n',
          extensions: ["omitted-plugin"],
        },
        "selected-owned.mjs": {
          source: "export const selected = true;\n",
          extensions: ["remote-runtime"],
        },
        "shared-owned.mjs": {
          source: "export const shared = true;\n",
          extensions: ["omitted-plugin", "remote-runtime"],
        },
        "selected-import.mjs": {
          source: "export const reachable = true;\n",
          extensions: ["omitted-plugin"],
        },
      });
      await write(packageRoot, "dist/unowned.mjs", "export const unowned = true;\n");
      if (selected) {
        await write(
          packageRoot,
          "dist/extensions/remote-runtime/index.js",
          'import "../../selected-owned.mjs"; import "../../shared-owned.mjs"; import "../../selected-import.mjs"; export { answer } from "../../shared.js";',
        );
      } else {
        await write(packageRoot, "dist/entry.js", "export {};\n");
      }
      const provider = createProvider({ ...options, plugins: selected ? options.plugins : [] });
      const artifact = await provider.prepare();
      const entries: string[] = [];
      await tar.list({
        file: artifact.tarballPath,
        onReadEntry: (entry) => entries.push(entry.path),
      });
      expect(entries).not.toContain("package/dist/omitted-owned.mjs");
      expect(entries).not.toContain("package/dist/extensions/omitted-plugin/index.js");
      expect(entries.includes("package/dist/shared-owned.mjs")).toBe(selected);
      expect(entries.includes("package/dist/selected-owned.mjs")).toBe(selected);
      expect(entries.includes("package/dist/selected-import.mjs")).toBe(selected);
      expect(entries).toContain("package/dist/unowned.mjs");
    },
  );

  it("rejects an incomplete omitted-plugin closure without ownership metadata", async () => {
    const { packageRoot, options, sourcePackage } = await fixture();
    await write(packageRoot, "package.json", {
      ...sourcePackage,
      files: [...sourcePackage.files, "!dist/extensions/omitted-plugin/**"],
    });
    await write(packageRoot, "dist/entry.js", "export {};\n");
    await write(packageRoot, "dist/extensions/omitted-plugin/index.js", "export {};\n");
    await write(
      packageRoot,
      "dist/omitted-owned.mjs",
      'import "./extensions/omitted-plugin/index.js";\n',
    );
    const provider = createProvider({ ...options, plugins: [] });
    await expect(provider.prepare()).rejects.toThrow("incomplete built import closure");
  });

  it("keeps explicit npm installs portable with exact pins and install hooks", async () => {
    const { root, packageRoot, options, sourcePackage } = await fixture();
    await write(packageRoot, "package.json", {
      ...sourcePackage,
      dependencies: { ...sourcePackage.dependencies, "uninstalled-native": "3.4.5" },
      optionalDependencies: { "other-platform-native": "2.3.4" },
    });
    await fs.rm(path.join(packageRoot, "node_modules/native-runtime"), { recursive: true });
    await write(packageRoot, "node-runtime-dependencies/invalid-target/runtime-input.json", {});
    const artifact = await createProvider({ ...options, install: "npm" }).prepare();
    expect(artifact.install).toBe("npm");
    const target = await extract(root, artifact);
    const manifest = JSON.parse(await readText(target, "package.json"));
    expect(manifest.dependencies).toEqual({
      "@fixture/ai": version,
      "native-runtime": "1.2.3",
      "uninstalled-native": "3.4.5",
    });
    expect(manifest.optionalDependencies).toEqual({ "other-platform-native": "2.3.4" });
    expect(manifest.bundleDependencies).toEqual(["@fixture/ai"]);
    expect(manifest.scripts).toEqual({
      preinstall: "node scripts/preinstall.mjs",
      postinstall: "node scripts/postinstall.mjs",
    });
    expect(manifest.devDependencies).toBeUndefined();
    expect(JSON.parse(await readText(target, "node-runtime.json"))).toMatchObject({
      install: "npm",
      platforms: [],
    });
    await expectFiles(target, {
      "node_modules/@fixture/ai/dist/index.js": 'export const name = "local-ai";',
      ".openclaw-lifecycle-pending": "pending\n",
    });
    await expectMissing(target, [
      "node_modules/native-runtime",
      "node_modules/uninstalled-native",
      "runtime-dependencies",
      "node-runtime-dependencies",
    ]);
    expect(await runNode(target)).toBe("local-ai:cloud-ready");
    await promisify(execFile)(process.execPath, [path.join(target, "scripts/postinstall.mjs")]);
    await expectMissing(target, [".openclaw-lifecycle-pending"]);
  });

  it("reuses the node archive after Gateway inventory finalization, but rejects changed runtime bytes", async () => {
    const { root, packageRoot, options } = await fixture();
    const first = await createProvider(options).prepare();
    const retained = gzipSync(gunzipSync(await fs.readFile(first.tarballPath)), { level: 1 });
    const retainedHash = createHash("sha256").update(retained).digest("hex");
    await fs.writeFile(path.join(packageRoot, "node-runtime.tgz"), retained);
    await write(packageRoot, "dist/postinstall-content-inventory.json", []);
    await write(
      packageRoot,
      "dist/postinstall-inventory.json",
      await collectPackageDistInventory(packageRoot),
    );
    const reused = await createProvider(options).prepare();
    expect(reused.tarballSha256).toBe(retainedHash);
    const target = await extract(root, reused);
    await expectMissing(target, ["dist/postinstall-content-inventory.json"]);
    expect(JSON.parse(await readText(target, "dist/postinstall-inventory.json"))).toEqual(
      await collectPackageDistInventory(target),
    );
    await write(packageRoot, "dist/entry.js", "export const changedRuntime = true;\n");
    const rebuilt = await createProvider(options).prepare();
    expect(rebuilt.tarballSha256).not.toBe(retainedHash);
    expect(await fs.readFile(path.join(packageRoot, "node-runtime.tgz"))).toEqual(retained);
  });

  it("treats a bundle prebuilt as an npm cache miss and reuses matching npm bytes", async () => {
    const { packageRoot, options, provider } = await fixture();
    const bundle = await provider.prepare();
    const bundleBytes = await fs.readFile(bundle.tarballPath);
    const prebuilt = path.join(packageRoot, "node-runtime.tgz");
    await fs.writeFile(prebuilt, bundleBytes);
    const npm = await createProvider({ ...options, install: "npm" }).prepare();
    expect(npm.install).toBe("npm");
    expect(npm.tarballSha256).not.toBe(bundle.tarballSha256);
    expect(await fs.readFile(prebuilt)).toEqual(bundleBytes);
    const retained = gzipSync(gunzipSync(await fs.readFile(npm.tarballPath)), { level: 1 });
    const retainedHash = createHash("sha256").update(retained).digest("hex");
    expect(retainedHash).not.toBe(npm.tarballSha256);
    await fs.writeFile(prebuilt, retained);
    const matching = await createProvider({ ...options, install: "npm" }).prepare();
    expect(matching.install).toBe("npm");
    expect(matching.tarballSha256).toBe(retainedHash);
    expect(await fs.readFile(matching.tarballPath)).toEqual(retained);
    expect(await fs.readFile(prebuilt)).toEqual(retained);
  });

  it("rejects a floating registry dependency in an explicit npm artifact", async () => {
    const { packageRoot, options, sourcePackage } = await fixture();
    await write(packageRoot, "package.json", {
      ...sourcePackage,
      dependencies: { ...sourcePackage.dependencies, "floating-native": "^3.4.5" },
    });
    await expect(createProvider({ ...options, install: "npm" }).prepare()).rejects.toThrow(
      "requires an exact dependency pin: floating-native@^3.4.5",
    );
  });

  it("packs and runs an installed CommonJS bundle with extensionless relative requires", async () => {
    const { root, packageRoot, provider, sourcePackage } = await fixture();
    const bundledName = "@fixture/undici";
    await write(packageRoot, "package.json", {
      ...sourcePackage,
      dependencies: { ...sourcePackage.dependencies, [bundledName]: "8.10.2" },
      bundleDependencies: [bundledName],
    });
    const bundledRoot = path.join(packageRoot, "node_modules", bundledName);
    const bundledFiles = {
      "package.json": { name: bundledName, version: "8.10.2", main: "./index-fetch.js" },
      "index-fetch.js": [
        'const global = require("./lib/global");',
        'const proxy = require("./lib/dispatcher/env-http-proxy-agent");',
        'const options = require("./lib/options");',
        "module.exports = `${global}:${proxy}:${options.mode}`;",
      ].join("\n"),
      "lib/global.js": 'module.exports = require("./state");',
      "lib/state/index.js": 'module.exports = "commonjs";',
      "lib/dispatcher/env-http-proxy-agent.js": 'module.exports = require("../proxy");',
      "lib/proxy/package.json": { main: "./runtime" },
      "lib/proxy/runtime/index.js": 'module.exports = "proxy";',
      "lib/options.json": { mode: "ready" },
    };
    await writeFiles(bundledRoot, bundledFiles);
    await write(
      packageRoot,
      "dist/entry.js",
      `import result from "${bundledName}"; console.log(result);`,
    );

    const artifact = await provider.prepare();
    const target = await extract(root, artifact);
    expect(await runNode(target)).toBe("commonjs:proxy:ready");
  });

  it.each([
    ["node-domexception", "@nolyfill/domexception"],
    ["@fixture/platform-linux-x64", "@fixture/platform"],
  ])("runs flattened registry alias %s with a different manifest name", async (requested, name) => {
    const { root, packageRoot, sourcePackage, provider } = await fixture("package");
    await write(packageRoot, "package.json", {
      ...sourcePackage,
      dependencies: { ...sourcePackage.dependencies, [requested]: `npm:${name}@1.0.28` },
    });
    await write(packageRoot, `node_modules/${requested}/package.json`, {
      name,
      version: "1.0.28",
      main: "./index.js",
      dependencies: { "nested-runtime": "1.0.0" },
    });
    await write(
      packageRoot,
      `node_modules/${requested}/index.js`,
      'module.exports = require("nested-runtime");',
    );
    await write(packageRoot, `node_modules/${requested}/node_modules/nested-runtime/package.json`, {
      name: "nested-runtime",
      version: "1.0.0",
      main: "./index.js",
    });
    await write(
      packageRoot,
      `node_modules/${requested}/node_modules/nested-runtime/index.js`,
      'module.exports = "alias-ready";',
    );
    await write(
      packageRoot,
      "dist/entry.js",
      `import value from "${requested}"; console.log(value);`,
    );
    const artifact = await provider.prepare();
    const installed = path.join(root, "node");
    await fs.mkdir(installed);
    await tar.extract({ file: artifact.tarballPath, cwd: installed });
    const { stdout } = await promisify(execFile)(process.execPath, [
      path.join(installed, "package/openclaw.mjs"),
    ]);
    expect(stdout.trim()).toBe("alias-ready");
  });

  it.each(["source", "linked-package"] as const)(
    "rejects an unbuilt %s workspace even when it has executable source",
    async (mode) => {
      const { root, provider } = await fixture(mode);
      const aiRoot =
        mode === "source"
          ? path.join(root, "ai-source")
          : path.join(root, "node_modules/linked-project/ai-source");
      await fs.rm(path.join(aiRoot, "dist"), { recursive: true });
      await write(aiRoot, "index.js", 'export const name = "unbuilt";');
      await expect(provider.prepare()).rejects.toThrow(
        "Node runtime dependency @fixture/ai has no executable distribution",
      );
    },
  );

  it("ships registry dependencies and nested versions as directly executable bytes", async () => {
    const { root, packageRoot, sourcePackage, options } = await fixture();
    await write(packageRoot, "package.json", {
      ...sourcePackage,
      dependencies: {
        ...sourcePackage.dependencies,
        "registry-runtime": "1.0.0",
        "shared-runtime": "2.0.0",
      },
    });
    await write(packageRoot, "node_modules/registry-runtime/package.json", {
      name: "registry-runtime",
      version: "1.0.0",
      main: "index.js",
      dependencies: { "shared-runtime": "1.0.0" },
    });
    await write(
      packageRoot,
      "node_modules/registry-runtime/index.js",
      'module.exports = require("shared-runtime");',
    );
    for (const [prefix, dependencyVersion] of [
      ["", "2.0.0"],
      ["registry-runtime/node_modules/", "1.0.0"],
    ]) {
      await write(packageRoot, `node_modules/${prefix}shared-runtime/package.json`, {
        name: "shared-runtime",
        version: dependencyVersion,
        main: "index.js",
      });
      await write(
        packageRoot,
        `node_modules/${prefix}shared-runtime/index.js`,
        `module.exports = "${dependencyVersion}";`,
      );
    }
    await write(
      packageRoot,
      "dist/entry.js",
      'import nested from "registry-runtime"; import root from "shared-runtime"; console.log(nested + ":" + root);',
    );
    const artifact = await createProvider(options).prepare();
    const installed = path.join(root, "directly-extracted");
    await fs.mkdir(installed);
    await tar.extract({ file: artifact.tarballPath, cwd: installed });
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [path.join(installed, "package/openclaw.mjs")],
      { env: { PATH: "", npm_config_registry: "http://127.0.0.1:9" } },
    );
    expect(stdout.trim()).toBe("1.0.0:2.0.0");
  });

  it("materializes dependencies from the selected plugin's installed owner", async () => {
    const { root, packageRoot, provider } = await fixture();
    await fs.rm(path.join(packageRoot, "node_modules/native-runtime"), { recursive: true });
    const dependency = "dist/extensions/remote-runtime/node_modules/native-runtime";
    await fs.rm(path.join(packageRoot, dependency), { recursive: true });
    await write(packageRoot, `${dependency}/package.json`, {
      name: "native-runtime",
      version: "1.2.3",
      type: "module",
      main: "index.js",
    });
    await write(packageRoot, `${dependency}/index.js`, 'export const answer = "plugin-owned";');
    await write(
      packageRoot,
      "dist/extensions/remote-runtime/index.js",
      'export { answer } from "native-runtime";',
    );
    const artifact = await provider.prepare();
    const installed = path.join(root, "plugin-closure");
    await fs.mkdir(installed);
    await tar.extract({ file: artifact.tarballPath, cwd: installed });
    const { stdout } = await promisify(execFile)(process.execPath, [
      path.join(installed, "package/openclaw.mjs"),
    ]);
    expect(stdout.trim()).toBe("local-ai:plugin-owned");
  });

  it("rejects a target dependency input whose frozen input fingerprints differ", async () => {
    const { packageRoot, sourcePackage, provider } = await fixture();
    const target = process.platform === "linux" ? "darwin-arm64" : "linux-x64";
    await write(packageRoot, `node-runtime-dependencies/${target}/package.json`, sourcePackage);
    await write(packageRoot, `node-runtime-dependencies/${target}/runtime-input.json`, {
      platform: target.split("-")[0],
      arch: target.split("-")[1],
      packageJsonSha256: "0".repeat(64),
      lockfileSha256: "0".repeat(64),
    });
    await expect(provider.prepare()).rejects.toThrow(
      "does not match the running source/dependencies",
    );
  });

  it("preserves an installed bundled dependency's runtime layout and assets", async () => {
    const { root, packageRoot, provider } = await fixture();
    const browserRoot = await writeBundledBrowser(packageRoot);
    await write(browserRoot, ".env", "FAKE_PRIVATE_VALUE=do-not-transfer");
    await write(root, "nested-native/host-native", "do-not-transfer-native");
    await fs.symlink(
      path.join(root, "nested-native"),
      path.join(browserRoot, "node_modules"),
      "junction",
    );
    await write(
      packageRoot,
      "dist/entry.js",
      'import { notice } from "@fixture/browser"; console.log(notice);',
    );
    const artifact = await provider.prepare();
    const target = await extract(root, artifact);
    const installedBrowser = path.join(target, "node_modules/@fixture/browser");
    await expectMissing(installedBrowser, [".env", "node_modules"]);
    for (const entry of [
      "openclaw.mjs",
      "node_modules/@fixture/browser/build/src/bin/browser.js",
    ]) {
      expect(await runNode(target, entry)).toBe("bundled-notice");
    }
    await expectFiles(installedBrowser, {
      "build/src/OPENCLAW_PATCH_NOTICE.md": "patched-runtime",
      "skills/browser/SKILL.md": "browser-skill",
      LICENSE: "fixture-license",
    });
  });

  it("retains an external plugin's hidden runtime chunks under its dist directory", async () => {
    const { root, pluginRoot, provider } = await fixture("external-plugin");
    await writeFiles(pluginRoot, {
      "dist/index.js": 'export { answer } from "./.setup/chunk-Q1w2E3.mjs";\n',
      "dist/.setup/chunk-Q1w2E3.mjs": 'export const answer = "cloud-ready";\n',
      "dist/.cache/credentials.json": { token: "do-not-transfer-host-private-metadata" },
      "dist/.setup/.cache/credentials.json": {
        token: "do-not-transfer-nested-host-private-metadata",
      },
      "dist/.setup/node_modules/private-dependency/index.js": "export const unused = true;\n",
    });
    const artifact = await provider.prepare();
    const target = await extract(root, artifact);
    const installedPlugin = path.join(target, "dist/extensions/remote-runtime");
    await expectFiles(installedPlugin, {
      "dist/.setup/chunk-Q1w2E3.mjs": 'export const answer = "cloud-ready";\n',
    });
    await expectMissing(installedPlugin, [
      ".env",
      "dist/.cache/credentials.json",
      "dist/.setup/.cache/credentials.json",
      "dist/.setup/node_modules/private-dependency/index.js",
    ]);
    expect(await runNode(target)).toBe("local-ai:cloud-ready");
  });

  it.each(["source", "package", "external-plugin", "linked-package"] as const)(
    "runs an unpublished %s snapshot with its plugin and private JavaScript dependency",
    async (mode) => {
      const { root, packageRoot, provider, sourcePackage } = await fixture(mode);
      const privateChunks: Record<string, OwnedRuntimeChunk> =
        mode === "source"
          ? {
              "opaque-A1b2C3.mjs": {
                source: 'import "./opaque-D4e5F6.mjs";\n',
                extensions: ["qa-lab"],
              },
              "opaque-D4e5F6.mjs": {
                source: 'import "./qa-runtime-private.mjs";\n',
                extensions: ["qa-channel", "qa-lab"],
              },
            }
          : {};
      if (mode === "source") {
        await writeOwnedChunks(packageRoot, privateChunks);
        await write(packageRoot, "dist/qa-runtime-private.mjs", "export {};\n");
      }
      const sourceOwnership =
        mode === "source"
          ? await readText(packageRoot, "dist/runtime-dependency-ownership.json")
          : undefined;
      // Node's getter temporarily changes the process mask and races parallel file creation.
      const readUmask = vi.spyOn(process, "umask").mockImplementation(() => {
        throw new Error("Artifact preparation must not read or mutate the process umask");
      });
      const [artifact, concurrent] = await Promise.all([
        provider.prepare(),
        provider.prepare(),
      ]).finally(() => readUmask.mockRestore());
      expect(concurrent).toBe(artifact);
      expect(artifact).toMatchObject({
        buildId,
        openclawVersion: version,
        enabledPluginIds: ["remote-runtime"],
        install: "bundle",
      });
      const bytes = await fs.readFile(artifact.tarballPath);
      expect(bytes.byteLength).toBe(artifact.tarballBytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(artifact.tarballSha256);
      const installed = path.join(root, "node");
      await fs.mkdir(installed);
      const entries: string[] = [];
      const modes = new Map<string, number | undefined>();
      await tar.extract({
        file: artifact.tarballPath,
        cwd: installed,
        onReadEntry: (entry) => {
          entries.push(entry.path);
          modes.set(entry.path, entry.mode);
        },
      });
      expect(entries).toContain("package/cli-parent-lifetime.mjs");
      expect(
        entries.some((entry) =>
          /(?:\.env|private\.ts|host-native|\.map|\.buildstamp)$/u.test(entry),
        ),
      ).toBe(false);
      expect(entries.some((entry) => entry.startsWith("package/dist/worker/"))).toBe(false);
      expect(entries.some((entry) => entry.startsWith("package/dist/worker-artifacts/"))).toBe(
        false,
      );
      expect(entries.some((entry) => entry.startsWith("package/dist/control-ui/"))).toBe(false);
      for (const [file, chunk] of Object.entries(privateChunks)) {
        expect(entries).not.toContain(`package/dist/${file}`);
        await expectFiles(packageRoot, { [`dist/${file}`]: chunk.source });
      }
      if (mode === "source") {
        expect(entries).not.toContain("package/dist/qa-runtime-private.mjs");
        await expectFiles(packageRoot, { "dist/qa-runtime-private.mjs": "export {};\n" });
        expect(await readText(packageRoot, "dist/runtime-dependency-ownership.json")).toBe(
          sourceOwnership,
        );
      }
      expect(await collectPackageDistInventory(packageRoot)).toEqual(
        expect.arrayContaining(["dist/control-ui/index.html", "dist/control-ui/assets/app.js"]),
      );
      if (process.platform !== "win32") {
        for (const [relative, requestedMode] of [
          ["openclaw.mjs", 0o755],
          ["dist/shared.js", 0o644],
        ] as const) {
          const sourceMode = (await fs.stat(path.join(packageRoot, relative))).mode;
          expect(modes.get(`package/${relative}`)).toBe(sourceMode & requestedMode);
        }
      }
      if (mode === "external-plugin") {
        expect(entries).not.toContain("package/dist/extensions/remote-runtime/index.js");
      }
      const target = path.join(installed, "package");
      await expectFiles(target, { "dist/empty.js": "" });
      expect(JSON.parse(await readText(target, longEntryPath))).toEqual({
        payload: longEntryPayload,
      });
      const manifest = JSON.parse(await readText(target, "package.json"));
      expect(manifest.dependencies).toEqual({ "@fixture/ai": version, "native-runtime": "1.2.3" });
      expect(manifest.bundleDependencies).toBeUndefined();
      expect(manifest.scripts).toBeUndefined();
      expect(manifest.devDependencies).toBeUndefined();
      await expect(
        fs.access(path.join(target, ".openclaw-lifecycle-pending")),
      ).rejects.toHaveProperty("code", "ENOENT");
      expect(
        JSON.parse(await readText(target, "node_modules/native-runtime/package.json")),
      ).toMatchObject({
        name: "native-runtime",
        version: "1.2.3",
      });
      expect(await runNode(target)).toBe("local-ai:cloud-ready");
      expect(JSON.parse(await readText(packageRoot, "package.json"))).toEqual(sourcePackage);
      await expectFiles(packageRoot, {
        "dist/extensions/remote-runtime/node_modules/native-runtime/vendor/host-native":
          "do-not-transfer-native",
      });
      await provider.close();
      await expect(fs.access(artifact.tarballPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(provider.prepare()).rejects.toThrow("closed");
    },
  );

  it.each([
    {
      name: "shared plugin ownership",
      extensions: ["qa-lab", "remote-runtime"],
      entry: "ownership",
    },
    { name: "public plugin ownership", extensions: ["remote-runtime"], entry: "ownership" },
    { name: "a current root import", extensions: ["qa-lab"], entry: "root" },
    { name: "a current root createRequire", extensions: ["qa-lab"], entry: "require" },
    { name: "an optional aliased loader", extensions: ["qa-lab"], entry: "optional-require" },
    { name: "a transitive current root import", extensions: ["qa-lab"], entry: "transitive" },
    { name: "the CLI launcher", extensions: ["qa-lab"], entry: "launcher" },
    { name: "a declared install script", extensions: ["qa-lab"], entry: "install" },
  ])("retains complete runtime chunks required by $name", async ({ extensions, entry }) => {
    const { root, packageRoot, provider } = await fixture();
    const chunks = {
      "opaque-A1b2C3.mjs": {
        source: 'export { retained } from "./opaque-D4e5F6.mjs";\n',
        extensions,
      },
      "opaque-D4e5F6.mjs": { source: "export const retained = true;\n", extensions },
    };
    await writeOwnedChunks(packageRoot, chunks);
    const importer =
      entry === "launcher"
        ? "openclaw.mjs"
        : entry === "install"
          ? "scripts/preinstall.mjs"
          : "dist/entry.js";
    const original = await readText(packageRoot, importer);
    const importSource =
      entry === "ownership"
        ? ""
        : entry === "require"
          ? 'import { createRequire } from "node:module"; const load = createRequire(import.meta.url); load("./opaque-A1b2C3.mjs");\n'
          : entry === "optional-require"
            ? 'import { createRequire } from "node:module"; const load = createRequire(import.meta.url); load?.(`./opaque-A1b2C3.mjs`);\n'
            : entry === "transitive"
              ? 'import "./bridge.js";\n'
              : entry === "launcher"
                ? 'await import(new URL("./dist/opaque-A1b2C3.mjs", import.meta.url));\n'
                : entry === "install"
                  ? 'await import(new URL("../dist/opaque-A1b2C3.mjs", import.meta.url));\n'
                  : 'import "./opaque-A1b2C3.mjs";\n';
    await write(packageRoot, importer, importSource + original);
    if (entry === "transitive") {
      await write(packageRoot, "dist/bridge.js", 'import "./opaque-A1b2C3.mjs";\n');
    }
    const artifact = await provider.prepare();
    const target = await extract(root, artifact);
    if (entry === "install") {
      await promisify(execFile)(process.execPath, [path.join(target, "scripts/preinstall.mjs")]);
    }
    expect(await runNode(target)).toBe("local-ai:cloud-ready");
    for (const [file, chunk] of Object.entries(chunks)) {
      await expectFiles(target, { [`dist/${file}`]: chunk.source });
    }
  });

  it("does not treat ordinary literal path arguments as required imports", async () => {
    const { packageRoot, provider } = await fixture();
    await writeOwnedChunks(packageRoot, {
      "opaque-A1b2C3.mjs": { source: "export {};\n", extensions: ["qa-lab"] },
    });
    const entry = await fs.readFile(path.join(packageRoot, "dist/entry.js"), "utf8");
    await write(packageRoot, "dist/entry.js", `String("./absent-user-directory");\n${entry}`);
    await expect(provider.prepare()).resolves.toMatchObject({ buildId });
  });

  it.each([
    { metadata: "stale", error: /ownership.*match/u },
    { metadata: "malformed", error: /ownership artifact/u },
    { metadata: "missing", error: /incomplete built import closure/u },
  ])("refuses private runtime omission with $metadata ownership", async ({ metadata, error }) => {
    const { packageRoot, provider } = await fixture();
    const source = 'import "./qa-runtime-private.mjs";\n';
    await writeOwnedChunks(packageRoot, {
      "opaque-A1b2C3.mjs": { source, extensions: ["qa-lab"] },
    });
    await write(packageRoot, "dist/qa-runtime-private.mjs", "export {};\n");
    if (metadata === "stale") {
      await write(packageRoot, "dist/opaque-A1b2C3.mjs", `${source}export const changed = true;\n`);
    } else if (metadata === "malformed") {
      await write(packageRoot, "dist/runtime-dependency-ownership.json", { chunks: [] });
    } else {
      await fs.rm(path.join(packageRoot, "dist/runtime-dependency-ownership.json"));
    }
    await expect(provider.prepare()).rejects.toThrow(error);
  });

  it("refuses a shortened non-JavaScript package member", async () => {
    const { packageRoot, provider } = await fixture();
    const entryPath = path.join(packageRoot, longEntryPath);
    const openFile = fs.open.bind(fs);
    let truncated = false;
    const reader = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await openFile(...args);
      if (args[0] === entryPath) {
        const stat = handle.stat.bind(handle);
        vi.spyOn(handle, "stat").mockImplementationOnce(async () => {
          const before = await stat();
          await fs.truncate(entryPath, 1);
          truncated = true;
          return before;
        });
      }
      return handle;
    });
    try {
      await expect(provider.prepare()).rejects.toThrow("Node distribution changed while packaging");
      expect(truncated).toBe(true);
    } finally {
      reader.mockRestore();
    }
  });

  it.each(["root resolution", "staging creation"])(
    "retries preparation after temporary %s becomes available",
    async (stage) => {
      const { provider } = await fixture();
      const failure = new Error("temporary storage unavailable");
      const makeTemp =
        stage === "root resolution"
          ? vi.spyOn(tmpDirs, "resolvePreferredOpenClawTmpDir").mockImplementationOnce(() => {
              throw failure;
            })
          : vi.spyOn(fs, "mkdtemp").mockRejectedValueOnce(failure);
      try {
        await expect(provider.prepare()).rejects.toThrow("temporary storage unavailable");
      } finally {
        makeTemp.mockRestore();
      }
      await expect(provider.prepare()).resolves.toMatchObject({ buildId });
    },
  );

  it("joins a failed archive output and removes it before a successful retry", async () => {
    const { provider } = await fixture();
    const makeTemp = fs.mkdtemp.bind(fs);
    let failedRoot: string | undefined;
    const destination = vi.spyOn(fs, "mkdtemp").mockImplementationOnce(async (...args) => {
      failedRoot = await makeTemp(...args);
      await fs.mkdir(path.join(failedRoot, "node-runtime.tgz"));
      return failedRoot;
    });
    try {
      await expect(provider.prepare()).rejects.toThrow();
      expect(failedRoot).toBeDefined();
      await expect(fs.access(failedRoot!)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      destination.mockRestore();
    }
    await expect(provider.prepare()).resolves.toMatchObject({ buildId });
  });

  it("cancels one waiting enrollment without abandoning shared artifact preparation", async () => {
    const { provider } = await fixture();
    const stagingRoot = tempDirs.make("node-artifact-held-");
    const entered = createDeferredCore();
    const resume = createDeferredCore<string>();
    const makeTemp = vi.spyOn(fs, "mkdtemp").mockImplementationOnce(async () => {
      entered.resolve();
      return await resume.promise;
    });
    const enrollment = new AbortController();
    const completed = vi.fn();
    const pending = provider.prepare(enrollment.signal).then(
      (artifact) => completed({ artifact }),
      (error: unknown) => completed({ error }),
    );
    const retained = provider.prepare();
    try {
      await entered.promise;
      enrollment.abort(new DOMException("enrollment cancelled", "AbortError"));
      await vi.waitFor(() =>
        expect(completed).toHaveBeenCalledExactlyOnceWith({
          error: expect.objectContaining({ name: "AbortError" }),
        }),
      );
      expect(makeTemp).toHaveBeenCalledOnce();
      resume.resolve(stagingRoot);
      const artifact = await retained;
      expect(await provider.prepare()).toBe(artifact);
      expect(makeTemp).toHaveBeenCalledOnce();
      await provider.close();
      await expect(fs.access(artifact.tarballPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      resume.resolve(stagingRoot);
      await Promise.allSettled([pending, retained]);
      makeTemp.mockRestore();
    }
  });

  it.each(["plugin", "private runtime", "bundled runtime"])(
    "rejects an incomplete %s import closure before publishing the artifact",
    async (owner) => {
      const { packageRoot, provider } = await fixture();
      if (owner === "plugin") {
        await fs.rm(path.join(packageRoot, "dist/shared.js"));
      } else if (owner === "bundled runtime") {
        const browserRoot = await writeBundledBrowser(packageRoot);
        await write(browserRoot, "build/src/transport.js", 'import "./missing.js";');
        await fs.appendFile(
          path.join(browserRoot, "build/src/index.js"),
          'import "./transport.js";',
        );
      } else {
        const aiRoot = await fs.realpath(path.join(packageRoot, "node_modules/@fixture/ai"));
        await write(aiRoot, "dist/index.js", 'export { name } from "./missing.js";');
      }
      await expect(provider.prepare()).rejects.toThrow("incomplete built import closure");
    },
  );

  it("rejects source/built plugin dependency drift and nonexact native pins", async () => {
    const { packageRoot, provider, pluginPackage } = await fixture();
    const changed = { ...pluginPackage, dependencies: { "native-runtime": "^1.3.0" } };
    await write(packageRoot, "extensions/remote-runtime/package.json", changed);
    await expect(provider.prepare()).rejects.toThrow("does not match source metadata");
    await write(packageRoot, "dist/extensions/remote-runtime/package.json", changed);
    await expect(provider.prepare()).rejects.toThrow("requires an exact dependency pin");
  });

  it.each(["Gateway", "bundled dependency"])(
    "rejects a link escaping the %s tree without reading the target into the artifact",
    async (owner) => {
      const { root, packageRoot, provider } = await fixture();
      await write(root, "private.json", { secret: "fixture-only" });
      const destination =
        owner === "Gateway"
          ? path.join(packageRoot, "dist/private.json")
          : path.join(await writeBundledBrowser(packageRoot), "build/src/private.json");
      await fs.symlink(path.join(root, "private.json"), destination);
      await expect(provider.prepare()).rejects.toThrow(
        owner === "Gateway" ? "Unsafe package dist path" : "Unsafe bundled node distribution path",
      );
    },
  );
});
