import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { copyBundledPluginMetadata } from "../../scripts/copy-bundled-plugin-metadata.mts";
import { collectSourceCheckoutPluginBuildEntries } from "../../scripts/lib/bundled-plugin-build-entries.mjs";
import {
  resolveAugmentedPluginNpmManifest,
  withAugmentedPluginNpmManifestForPackage,
} from "../../scripts/lib/plugin-npm-package-manifest.mts";
import { resolvePluginNpmRuntimeBuildPlan } from "../../scripts/lib/plugin-npm-runtime-build.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { emptyModules, readFixtureJson, writeFixtureFiles } from "./z0632-fixtures.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
function catalogs(prefix: string, extension: string) {
  return {
    capabilityCatalogEntry: `${prefix}/catalog/voice${extension}`,
    providerCatalogEntry: `${prefix}/catalog/models${extension}`,
  };
}

it.each([
  { runtimeFormat: "esm", browser: false },
  { runtimeFormat: "cjs", browser: false },
  { runtimeFormat: "esm", browser: true },
] as const)(
  "carries declarations into $runtimeFormat artifacts (browser: $browser)",
  ({ runtimeFormat, browser }) => {
    const root = tempDirs.make("openclaw-catalog-artifacts-");
    const plugin = path.join(root, "extensions", "catalog-fixture");
    const readManifest = () => fs.readFileSync(path.join(plugin, "openclaw.plugin.json"), "utf8");
    const params = { repoRoot: root, packageDir: plugin };
    const manifest = {
      id: "catalog-fixture",
      configSchema: { type: "object" },
      ...(browser
        ? { controlUi: { entry: "dist/control-ui/authored/index.js" } }
        : catalogs(".", ".ts")),
    };
    writeFixtureFiles(root, { "package.json": { name: "openclaw" } });
    writeFixtureFiles(plugin, {
      "openclaw.plugin.json": manifest,
      "package.json": {
        name: "@openclaw/catalog-fixture",
        version: "2026.9.1",
        openclaw: {
          extensions: ["./index.ts"],
          ...(browser ? { controlUi: "./browser.ts" } : {}),
          release: { publishToNpm: true },
          build: { bundledDist: false, runtimeFormat },
        },
      },
      ...emptyModules(["index.ts", "browser.ts", "catalog/voice.ts", "catalog/models.ts"]),
    });

    const [entry] = collectSourceCheckoutPluginBuildEntries({ cwd: root, env: {} });
    const extension = runtimeFormat === "cjs" ? ".cjs" : ".js";
    const plan = resolvePluginNpmRuntimeBuildPlan(params)!;
    const expected = browser
      ? { controlUi: { entry: "dist/control-ui/fresh/index.js" } }
      : catalogs("./dist", extension);
    if (browser) {
      writeFixtureFiles(plugin, {
        "dist/openclaw.plugin.json": expected,
        ...emptyModules(plan.runtimeBuildOutputs),
      });
      const authoredBytes = readManifest();
      withAugmentedPluginNpmManifestForPackage(params, () => {
        expect(JSON.parse(readManifest())).toMatchObject(expected);
      });
      expect(readManifest()).toBe(authoredBytes);
    } else {
      expect(entry?.sourceEntries).toEqual(
        expect.arrayContaining(["./catalog/voice.ts", "./catalog/models.ts"]),
      );
      expect(plan.entry["catalog/voice"]).toBe(path.join(plugin, "catalog/voice.ts"));
      expect(plan.runtimeBuildOutputs).toContain(`./dist/catalog/voice${extension}`);
    }
    expect(resolveAugmentedPluginNpmManifest(params).manifest).toMatchObject(expected);

    copyBundledPluginMetadata({ cwd: root, env: {} });
    const emitted = readFixtureJson(root, "dist/extensions/catalog-fixture/openclaw.plugin.json");
    expect(emitted).toMatchObject(browser ? expected : catalogs(".", extension));
    expect(JSON.parse(readManifest())).toEqual(manifest);
  },
);

it("publishes a source public export as a directly importable built Node API", () => {
  const root = tempDirs.make("openclaw-public-artifact-");
  const source = path.join(root, "extensions", "public-fixture");
  const built = path.join(root, "dist", "extensions", "public-fixture");
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(built, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));
  const manifest = {
    name: "@example/public-fixture",
    version: "1.2.3",
    type: "module",
    exports: { "./cli-runtime-api.js": "./cli-runtime-api.ts" },
    openclaw: { extensions: ["./index.ts"] },
  };
  fs.writeFileSync(path.join(source, "package.json"), JSON.stringify(manifest));
  fs.writeFileSync(
    path.join(source, "openclaw.plugin.json"),
    JSON.stringify({ id: "public-fixture", configSchema: { type: "object" } }),
  );
  fs.writeFileSync(path.join(source, "index.ts"), "export default {};\n");
  fs.writeFileSync(path.join(source, "cli-runtime-api.ts"), 'export const marker = "source";\n');
  fs.writeFileSync(path.join(built, "cli-runtime-api.js"), 'export const marker = "compiled";\n');
  copyBundledPluginMetadata({ cwd: root, env: {} });
  const require = createRequire(path.join(built, "package.json"));
  const entry = require.resolve("@example/public-fixture/cli-runtime-api.js");
  expect(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const api = await import(${JSON.stringify(entry)}); process.stdout.write(api.marker);`,
      ],
      { encoding: "utf8" },
    ),
  ).toBe("compiled");
  expect(JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8"))).toEqual(manifest);
});
