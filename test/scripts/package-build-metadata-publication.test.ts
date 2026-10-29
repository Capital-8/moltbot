import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { scriptProcessEntrypoints } from "../../scripts/script-process-runtime.test-support.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../src/infra/runtime-worker-url.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import {
  AI_RUNTIME_FILES,
  AI_RUNTIME_PACKAGE_JSON,
  BUNDLED_AI_PACKAGE_OPTIONS,
  expectPackageCommandSuccess,
  listFilesRecursively,
  withTarball,
} from "./package-tarball-fixture.js";

const CHECK_SCRIPT = "scripts/check-openclaw-package-tarball.mts";

describe("package build metadata publication", () => {
  it.each(["npm", "pnpm"] as const)(
    "%s publishes runtime files and bundled AI without source-build ledgers",
    (pack) => {
      const rootManifest = JSON.parse(readFileSync("package.json", "utf8"));
      const aiManifest = JSON.parse(readFileSync("packages/ai/package.json", "utf8"));
      const metadata = {
        "dist/.source-module-urls/build.json": '{"build":"root"}\n',
        "dist/extensions/example/.source-module-urls/build.json": '{"build":"plugin"}\n',
      };
      const aiMetadata = "dist/.source-module-urls/build.json";
      const aiFiles = Object.fromEntries(
        Object.entries(AI_RUNTIME_FILES)
          .filter(([name]) => name.startsWith("node_modules/@openclaw/ai/dist/"))
          .map(([name, contents]) => [name.replace("node_modules/@openclaw/ai/", ""), contents]),
      );
      aiFiles["dist/index.mjs"] = "export const fixture = 'ai-runtime';\n";
      aiFiles[aiMetadata] = '{"build":"ai"}\n';
      aiFiles["dist/.source-module-urls-public/keep.json"] = "{}\n";
      withTarball(
        [],
        {
          ...metadata,
          "dist/index.js": "export const fixture = 'root-runtime';\n",
          "dist/.source-module-urls-public/keep.json": "{}\n",
        },
        (tarball, root, packageRoot) => {
          const listing = spawnSync("tar", ["-tzf", tarball], { encoding: "utf8" });
          expectPackageCommandSuccess(listing, "list published package");
          expect(
            listing.stdout
              .split("\n")
              .some((name) => name.split("/").includes(".source-module-urls")),
          ).toBe(false);
          for (const name of [
            "dist/.source-module-urls-public/keep.json",
            "node_modules/@openclaw/ai/dist/.source-module-urls-public/keep.json",
          ]) {
            expect(listing.stdout).toContain(`package/${name}`);
          }
          for (const [name, contents] of Object.entries(metadata)) {
            expect(readFileSync(join(packageRoot, name), "utf8")).toBe(contents);
          }
          const checked = spawnSync(resolveTestNodeExecPath(), [resolve(CHECK_SCRIPT), tarball], {
            encoding: "utf8",
          });
          expectPackageCommandSuccess(checked, "verify published filename/content inventories");
          const installed = join(root, "installed");
          mkdirSync(installed);
          expectPackageCommandSuccess(
            spawnSync("tar", ["-xzf", tarball, "--strip-components=1", "-C", installed], {
              encoding: "utf8",
            }),
            "extract published package",
          );
          const loaded = spawnSync(
            resolveTestNodeExecPath(),
            [
              "--input-type=module",
              "--eval",
              "import assert from 'node:assert/strict'; import { fixture } from './dist/index.js'; import { fixture as ai } from '@openclaw/ai'; assert.equal(fixture, 'root-runtime'); assert.equal(ai, 'ai-runtime');",
            ],
            { cwd: installed, encoding: "utf8" },
          );
          expectPackageCommandSuccess(loaded, "load published root and AI exports");
        },
        "2026.9.4",
        {
          pack,
          packageJson: {
            ...BUNDLED_AI_PACKAGE_OPTIONS.packageJson,
            type: "module",
            files: rootManifest.files,
          },
          beforePack: (packageRoot) => {
            withTarball(
              [],
              aiFiles,
              (tarball, _root, aiRoot) => {
                const stagedAi = join(packageRoot, "node_modules/@openclaw/ai");
                mkdirSync(stagedAi, { recursive: true });
                expectPackageCommandSuccess(
                  spawnSync("tar", ["-xzf", tarball, "--strip-components=1", "-C", stagedAi], {
                    encoding: "utf8",
                  }),
                  "stage independently packed AI",
                );
                expect(readFileSync(join(aiRoot, aiMetadata), "utf8")).toBe(aiFiles[aiMetadata]);
                expect(existsSync(join(stagedAi, aiMetadata))).toBe(false);
              },
              "2026.6.11",
              {
                pack,
                inventoryBody: null,
                includeCodeModeWorker: false,
                includeControlUi: false,
                includeLifecycleMarker: false,
                includeWorkspaceTemplates: false,
                packageJson: {
                  ...JSON.parse(AI_RUNTIME_PACKAGE_JSON),
                  type: "module",
                  files: aiManifest.files,
                },
              },
            );
            for (const name of listFilesRecursively(packageRoot)) {
              chmodSync(join(packageRoot, name), 0o644);
            }
            const writer = resolveRuntimeWorkerUrl(scriptProcessEntrypoints.packageDistInventory);
            const nodeExecPath = resolveTestNodeExecPath();
            const written = spawnSync(
              nodeExecPath,
              resolveRuntimeWorkerArgv(writer, nodeExecPath),
              {
                cwd: packageRoot,
                encoding: "utf8",
                timeout: 30_000,
                env: {
                  ...process.env,
                  TSX_TSCONFIG_PATH: resolve("tsconfig.json"),
                  TSX_DISABLE_CACHE: "1",
                },
              },
            );
            expectPackageCommandSuccess(written, "prepare canonical publication inventories");
          },
        },
      );
    },
  );
});
