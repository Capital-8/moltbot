import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { hasMlxNativeProofInputs } from "../../scripts/ci-changed-scope.mjs";

it.skipIf(process.platform === "win32")(
  "retains the original job clock across fresh Node owners",
  () => {
    const budgetURL = new URL("../../scripts/lib/native-ci-budget.mts", import.meta.url).href;
    const program = `
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
const {NativeCiBudget}=await import(${JSON.stringify(budgetURL)});
const original=execFileSync('python3',['-I','-S','-c','import time; print(time.monotonic()-26*60)'],{encoding:'utf8'}).trim();
const first=new NativeCiBudget(original);
assert(first.timeout(120000)<61000);
const second=new NativeCiBudget(original);
assert(second.timeout(120000)<=first.timeout(120000)+100);
assert(second.timeout(300000,true)<241000);
assert.throws(()=>new NativeCiBudget('NaN'));
assert.throws(()=>new NativeCiBudget(String(Number(original)-120)),/Invalid or exhausted/);
console.log('original-clock-bounded');
`;
    expect(
      execFileSync(process.execPath, ["--input-type=module", "-e", program], {
        encoding: "utf8",
        timeout: 15_000,
      }),
    ).toContain("original-clock-bounded");
  },
);

it.skipIf(process.platform === "win32")(
  "accepts fractional Python clock subtraction without extending either deadline",
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-budget-"));
    try {
      const started = 2300.123456789;
      const now = started + 10.25;
      const sample = [started + 27 * 60 - now, started + 30 * 60 - now];
      expect(sample[1]! - sample[0]!).not.toBe(180);
      fs.writeFileSync(
        path.join(root, "python3"),
        `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(sample))});\n`,
        { mode: 0o700 },
      );
      const url = new URL("../../scripts/lib/native-ci-budget.mts", import.meta.url).href;
      const program = `import assert from 'node:assert/strict'; import {performance} from 'node:perf_hooks'; const {NativeCiBudget}=await import(${JSON.stringify(url)}); const budget=new NativeCiBudget(${JSON.stringify(String(started))}); const after=performance.now(); assert(budget.workEnd<=after+${sample[0]! * 1000}); assert(budget.cleanupEnd<=after+${sample[1]! * 1000}); console.log('fractional-clock-bounded');`;
      expect(
        execFileSync(process.execPath, ["--input-type=module", "-e", program], {
          encoding: "utf8",
          env: { ...process.env, PATH: root + path.delimiter + process.env.PATH },
          timeout: 10_000,
        }),
      ).toContain("fractional-clock-bounded");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

it.each([
  "scripts/test-macos-mlx-settings.mts",
  "scripts/lib/native-ci-budget.mts",
  "scripts/test-macos-native.mts",
  "test/helpers/macos-mlx-settings-producer.ts",
  "apps/macos/Tests/OpenClawIPCTests/MLXSettingsUpgradeTests.swift",
])("selects the native proof owner for %s without a new public flag", (file) => {
  expect(hasMlxNativeProofInputs([file])).toBe(true);
});

it("uses source-owned validation and leaves the native producer unmocked", () => {
  const source = fs.readFileSync(
    fileURLToPath(new URL("../helpers/macos-mlx-settings-producer.ts", import.meta.url)),
    "utf8",
  );
  expect(source).toContain("validateTalkConfigResult(value)");
  expect(source).toContain("paths.CONFIG_PATH, rawURL");
  expect(source).toContain(
    "captureRuntimeConfigWithSource(snapshot.config, snapshot.sourceConfig)",
  );
  expect(source).not.toMatch(
    /vi\.|mock\(|readConfigFileSnapshotFromRaw|pluginValidation:\s*["'](?:skip|core-only)/,
  );
});
