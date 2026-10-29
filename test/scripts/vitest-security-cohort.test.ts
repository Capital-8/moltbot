import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const checkout = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(import.meta.url);
const uiRequire = createRequire(path.join(checkout, "ui/package.json"));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function prepareFixture() {
  const root = tempDirs.make("vitest-security-cohort-");
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ type: "module", workspaces: [] }),
  );
  fs.symlinkSync(path.join(checkout, "node_modules"), path.join(root, "node_modules"), "junction");
  return root;
}

function runNode(root: string, args: string[]) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, HOME: root, CI: "1" },
    timeout: 15_000,
  });
  expect(result.status, String(result.error ?? "") + result.stdout + result.stderr).toBe(0);
  return result;
}

it("keeps the core, browser, UI, and V8 coverage packages on one version", () => {
  const version = require("vitest/package.json").version;
  const vitestRequire = createRequire(uiRequire.resolve("vitest/package.json"));
  for (const [resolver, name] of [
    [require, "@vitest/coverage-v8"],
    [uiRequire, "vitest"],
    [uiRequire, "@vitest/browser"],
    [uiRequire, "@vitest/browser-playwright"],
    [vitestRequire, "@vitest/ui"],
    [vitestRequire, "@vitest/mocker"],
  ] as const) {
    expect(resolver(name + "/package.json").version, name).toBe(version);
  }
});

it("serves authenticated UI assets while denying private files on root and browser project servers", () => {
  const root = prepareFixture();
  fs.writeFileSync(path.join(root, "server.pem"), "private-key-canary");
  fs.writeFileSync(path.join(root, ".env"), 'SECURITY_CANARY="not-served"');
  fs.writeFileSync(path.join(root, ".vitest-secret-token"), "not-a-real-token");
  fs.writeFileSync(path.join(root, "public.js"), "export const value = 42;");
  const result = runNode(root, [
    "--input-type=module",
    "--eval",
    `
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(
  ${JSON.stringify(path.join(checkout, "ui/package.json"))}
);
const { createVitest } = await import(pathToFileURL(require.resolve("vitest/node")));
const { playwright } = await import(pathToFileURL(require.resolve("@vitest/browser-playwright")));
let ctx;
try {
  ctx = await createVitest("test", {
    root: process.cwd(),
    config: false,
    watch: false,
    ui: true,
    open: false,
    api: { host: "127.0.0.1", port: 0 },
    projects: [{
      extends: false,
      root: process.cwd(),
      test: {
        name: "browser-security",
        api: { host: "127.0.0.1", port: 0 },
        browser: {
          enabled: true,
          headless: true,
          provider: playwright(),
          instances: [{ browser: "chromium" }],
        },
      },
    }],
  });
  const servers = [["root-ui", ctx.vite], ...ctx.projects.map(p => [p.name, p.vite])];
  assert.equal(servers.length, 2);
  for (const [name, server] of servers) {
    if (!server.httpServer?.listening) await server.listen(0);
    const base = "http://127.0.0.1:" + server.httpServer.address().port;
    const publicResponse = await fetch(base + "/public.js");
    assert.equal(publicResponse.status, 200);
    assert.match(await publicResponse.text(), /value = 42/);
    for (const file of [".env?raw", "server.pem?raw", ".vitest-secret-token?raw"]) {
      const response = await fetch(base + "/" + file);
      const body = await response.text();
      assert.equal(response.status, 403, name + ": " + file);
      assert.ok(!body.includes("not-served") && !body.includes("not-a-real-token") && !body.includes("private-key-canary"));
    }
    if (name === "root-ui") {
      const unauthenticated = await fetch(base + "/__vitest__/");
      assert.equal(unauthenticated.status, 403);
      await unauthenticated.text();
      const bootstrap = await fetch(
        base + "/__vitest__/?token=" + encodeURIComponent(ctx.config.api.token),
        { redirect: "manual" },
      );
      assert.equal(bootstrap.status, 302);
      const cookie = bootstrap.headers.get("set-cookie").split(";")[0];
      const response = await fetch(base + "/__vitest__/", { headers: { cookie } });
      assert.equal(response.status, 200);
      assert.match(await response.text(), /html/i);
    }
  }
  console.log("private-file checks passed on 2 servers");
} finally {
  await ctx?.close();
}
`,
  ]);
  expect(result.stdout).toContain("private-file checks passed on 2 servers");
});

it("runs the V8 coverage provider and emits instrumented source coverage", () => {
  const root = prepareFixture();
  fs.writeFileSync(path.join(root, "answer.js"), "export const answer = () => 42;");
  fs.writeFileSync(
    path.join(root, "answer.test.js"),
    'import { test, expect } from "vitest"; import { answer } from "./answer.js"; test("answer", () => expect(answer()).toBe(42));',
  );
  const config = path.join(root, "vitest.config.mjs");
  fs.writeFileSync(
    config,
    "export default " +
      JSON.stringify({
        root,
        test: {
          include: ["answer.test.js"],
          maxWorkers: 1,
          coverage: {
            enabled: true,
            provider: "v8",
            reporter: ["json"],
            include: ["answer.js"],
            reportsDirectory: "coverage",
          },
        },
      }),
  );
  runNode(root, [
    path.join(path.dirname(require.resolve("vitest/package.json")), "vitest.mjs"),
    "run",
    "--config",
    config,
  ]);
  const coverage = JSON.parse(
    fs.readFileSync(path.join(root, "coverage/coverage-final.json"), "utf8"),
  );
  const source = coverage[path.join(root, "answer.js")];
  expect(source).toBeDefined();
  expect(Object.values(source.s)).not.toHaveLength(0);
  expect(Object.values(source.s).every((hits) => typeof hits === "number" && hits > 0)).toBe(true);
});
