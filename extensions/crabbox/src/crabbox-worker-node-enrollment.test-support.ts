import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  fixtureReceiptClientSource,
  type FixtureReceiptChannel,
  withinTest,
} from "openclaw/plugin-sdk/test-fixtures";
import * as tar from "tar";
import { expect, it } from "vitest";
import { withCrabboxWorkerEnvProfile } from "./crabbox-worker-env-profile.js";
import {
  createCrabboxNodeEnrollmentSetup,
  createCrabboxNodeRuntimeSetup,
  type CrabboxWorkerNodeEnrollment,
  type CrabboxWorkerNodeRuntimePreparation,
} from "./crabbox-worker-node-enrollment.js";
import type { CrabboxOperatingSystem } from "./crabbox-worker-profile.js";
import { readCrabboxRuntimeInstallation } from "./crabbox-worker-runtime-verification.js";

export type DesktopFixture = {
  enabled: boolean;
  setup?: string;
  display?: string;
  dbus?: string;
  runtimeDir?: string;
};

export function createNodeEnrollmentRunner(leaseId: string, setupCode: string) {
  return async function enroll(
    home: string,
    nodeBootstrap: CrabboxWorkerNodeEnrollment["nodeBootstrap"],
    desktop?: DesktopFixture,
    runtimeOnly = false,
    workerBundle?: CrabboxWorkerNodeEnrollment["nodeBootstrap"] & { packageRelativePath: string },
    options?: {
      credentials?: string;
      timeoutMs?: number;
      signal?: AbortSignal;
      workerCodex?: NonNullable<CrabboxWorkerNodeEnrollment["workerCodex"]>;
      trustBin?: string;
      target?: CrabboxOperatingSystem;
    },
  ) {
    const bin = path.join(home, "bin");
    const proc = path.join(home, "proc");
    fs.mkdirSync(bin, { recursive: true });
    // The generated Linux enrollment must never refresh the test host's trust store.
    fs.writeFileSync(path.join(bin, "update-ca-certificates"), "#!/bin/sh\nexit 0\n", {
      mode: 0o700,
    });
    fs.writeFileSync(
      path.join(bin, "sudo"),
      '#!/bin/sh\nset -eu\ntest "$1" = -n && test "$2" = --\nshift 2\nexec "$@"\n',
      { mode: 0o700 },
    );
    if (desktop) {
      fs.mkdirSync(path.join(proc, "123"), { recursive: true });
      fs.writeFileSync(path.join(home, "desktop.env"), "CRABBOX_DESKTOP_ENV=xfce\nDISPLAY=:99\n");
      fs.writeFileSync(
        path.join(proc, "123", "environ"),
        [
          `DISPLAY=${desktop.display ?? ":99"}`,
          `DBUS_SESSION_BUS_ADDRESS=${desktop.dbus ?? "unix:path=/run/fixture/bus"}`,
          `XDG_RUNTIME_DIR=${desktop.runtimeDir ?? "/run/fixture"}`,
          "UNRELATED_DESKTOP_VALUE=do-not-export",
          "",
        ].join("\0"),
      );
      fs.writeFileSync(
        path.join(bin, "pgrep"),
        `#!/bin/sh
set -eu
[ "$*" = "-u $(id -u) -x xfce4-session" ]
[ -z "\${CRABBOX_WORKER_BOOTSTRAP_TOKEN-}" ]
[ -z "\${CRABBOX_WORKER_SETUP_CODE-}" ]
echo 123
`,
        { mode: 0o700 },
      );
    }
    const setup = runtimeOnly
      ? createCrabboxNodeRuntimeSetup({
          leaseId,
          nodeBootstrap,
          workerBundle: workerBundle!,
          target: options?.target,
        })
      : createCrabboxNodeEnrollmentSetup({
          leaseId,
          target: options?.target,
          desktop: desktop?.enabled,
          desktopSetup: desktop?.setup,
          enrollment: {
            mode: "connect",
            setupCode,
            setupId: "bootstrap-test",
            openclawVersion: "2026.8.1",
            nodeBootstrap,
            workerCodex: options?.workerCodex,
            displayName: "Bootstrap test",
            waitForDeviceId: async () => "device-test",
          },
        });
    expect(setup.command).not.toContain(nodeBootstrap.token);
    expect(setup.command).not.toContain(setupCode);
    const timers = path.join(home, "bootstrap-test-timers.cjs");
    fs.writeFileSync(timers, 'require("node:timers/promises").setTimeout = async () => {};\n');
    if (options?.workerCodex) {
      await withCrabboxWorkerEnvProfile(setup.forwardedEnv, async (names, profilePath) => {
        expect(names).toContain("CRABBOX_WORKER_CODEX_CONFIG_BASE64");
        expect(profilePath).toBeDefined();
      });
    }
    const child = spawn("/bin/sh", [], {
      env: {
        HOME: home,
        NODE_OPTIONS: `--require ${JSON.stringify(timers)}`,
        PATH: `${options?.trustBin ?? bin}:${process.env.PATH}`,
        ...(desktop
          ? {
              DISPLAY: ":0",
              DBUS_SESSION_BUS_ADDRESS: "wrong-login-session",
              XDG_RUNTIME_DIR: "/run/wrong",
            }
          : {}),
        ...setup.forwardedEnv,
        ...(options?.credentials ? { CRABBOX_WORKER_BOOTSTRAP_TOKEN: options.credentials } : {}),
        // Exercise the installer overriding an inherited package-manager default.
        NPM_CONFIG_IGNORE_SCRIPTS: "true",
        npm_config_registry: "http://127.0.0.1:9/unreachable-registry",
      },
      detached: true,
      stdio: "pipe",
    });
    const timeout = options?.timeoutMs
      ? setTimeout(() => {
          if (child.pid) {
            process.kill(-child.pid, "SIGKILL");
          }
        }, options.timeoutMs)
      : undefined;
    const output: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => output.push(chunk));
    // Replace only OS fixture roots; the generated bootstrap and credential flow execute unchanged.
    child.stdin.end(
      setup.command
        .replaceAll(
          "/usr/sbin/update-ca-certificates",
          path.join(options?.trustBin ?? bin, "update-ca-certificates"),
        )
        .replaceAll("/var/lib/crabbox/desktop.env", path.join(home, "desktop.env"))
        .replaceAll("/proc/$process_pid/environ", `${proc}/$process_pid/environ`),
    );
    const closed = once(child, "close");
    try {
      const [code] = await (options?.signal ? withinTest(closed, options.signal) : closed);
      return {
        code,
        output: Buffer.concat(output).toString("utf8"),
        ...(runtimeOnly && workerBundle ? { installation: { nodeBootstrap, workerBundle } } : {}),
      };
    } finally {
      clearTimeout(timeout);
      const active = child.exitCode === null && child.signalCode === null;
      if (options?.signal?.aborted && child.pid && active) {
        // The enrollment shell owns desktop setup; stop its group before releasing the FIFO.
        process.kill(-child.pid, "SIGKILL");
      }
      await closed;
    }
  };
}

export function createWorkerArchiveFixture(): CrabboxWorkerNodeRuntimePreparation["workerBundle"] {
  return {
    url: "https://gateway.example.test/__openclaw__/worker-bootstrap/artifacts/worker",
    token: "synthetic-worker-archive-token",
    sha256: "b".repeat(64),
    bytes: 100,
    packageRelativePath: `worker-artifacts/${"b".repeat(64)}.tgz`,
  };
}

export function createNodeBootstrapFixture(
  overrides: Partial<CrabboxWorkerNodeEnrollment["nodeBootstrap"]> = {},
): CrabboxWorkerNodeEnrollment["nodeBootstrap"] {
  return {
    url: "https://gateway.example.test/__openclaw__/node-bootstrap/v1/artifact",
    token: "synthetic-bootstrap-token",
    sha256: "a".repeat(64),
    bytes: 100,
    openclawVersion: "2026.8.1",
    buildId: "fixture-runtime-build",
    enabledPluginIds: ["demo"],
    ...overrides,
  };
}

/** Real bytes and hashes for virtual-filesystem runtime verification tests. */
export function createRuntimeVerificationFixture(
  platform: "linux" | "darwin",
  options: { arch?: string; files?: ReadonlyMap<string, Buffer> } = {},
) {
  const files = new Map<string, Buffer>([
    ["package.json", Buffer.from(JSON.stringify({ name: "openclaw", version: "2026.8.1" }))],
    [
      "node-runtime.json",
      Buffer.from(
        JSON.stringify({
          buildId: "fixture-runtime-build",
          openclawVersion: "2026.8.1",
          platforms: [{ platform, arch: options.arch ?? "x64", prefix: "" }],
        }),
      ),
    ],
    ["openclaw.mjs", Buffer.from("// synthetic runtime probe entrypoint\n")],
  ]);
  for (const [name, bytes] of options.files ?? []) {
    files.set(name, bytes);
  }
  const inventory = [...files].map(([name, bytes]) => ({
    path: "package/" + name,
    size: bytes.length,
    mode: 0o600,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }));
  const manifest = Buffer.from(JSON.stringify(inventory));
  files.set("node-runtime.manifest.json", manifest);
  return {
    files,
    nodeBootstrap: createNodeBootstrapFixture({
      manifestSha256: createHash("sha256").update(manifest).digest("hex"),
    }),
  };
}

export async function readLaunch(
  stateDir: string,
  receipts: FixtureReceiptChannel,
  signal: AbortSignal,
) {
  // Enrollment writes node.pid before completing; the child publishes JSON before its receipt.
  const pid = fs.readFileSync(path.join(stateDir, "node.pid"), "utf8").trim();
  await withinTest(receipts.waitFor(stateDir, `launched:${pid}:ready`), signal);
  return JSON.parse(fs.readFileSync(path.join(stateDir, "launch.json"), "utf8")) as {
    build: string;
    cli: string;
    args: string[];
    token?: string;
    setupCode?: string;
    tool?: string;
    environment: Record<string, string>;
    enabledPlugins: string[];
  };
}

export async function createNodePackageFixture(
  makeTempDir: (prefix: string) => string,
  build: string,
  receipts: FixtureReceiptChannel,
  postinstall = "",
  install: "bundle" | "npm" = "bundle",
): Promise<Buffer> {
  const root = makeTempDir("crabbox-bootstrap-package-");
  const packageRoot = path.join(root, "package");
  fs.mkdirSync(packageRoot);
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: "openclaw",
      version: "2026.8.1",
      scripts: { postinstall: "node install.cjs" },
      dependencies: { "runtime-fixture": "1.0.0" },
      ...(install === "npm" ? { bundleDependencies: ["runtime-fixture"] } : {}),
    }),
  );
  fs.writeFileSync(
    path.join(packageRoot, "install.cjs"),
    `require("node:fs").writeFileSync("installed.json", JSON.stringify({ token: process.env.CRABBOX_WORKER_BOOTSTRAP_TOKEN, setupCode: process.env.CRABBOX_WORKER_SETUP_CODE, scriptsRan: true }));require("node:fs").appendFileSync("install-count", "run\\n");${postinstall}`,
  );
  fs.writeFileSync(
    path.join(packageRoot, "openclaw.mjs"),
    `import fs from "node:fs";
import { version } from "runtime-fixture";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
${fixtureReceiptClientSource(receipts.endpoint)}
const args = process.argv.slice(2);
const state = process.env.OPENCLAW_STATE_DIR;
if (args[0] === "--version") {
  console.log("OpenClaw " + version);
} else if (args[0] === "plugins" && args[1] === "enable") {
  fs.appendFileSync(path.join(state, "activation.jsonl"), JSON.stringify({ runtimePublished: fs.existsSync(path.join(state, "runtime")) }) + "\\n");
  if (${JSON.stringify(build)} === "activation-failed") { console.error("plugin dependency missing"); process.exit(1); }
  for (const id of args.slice(2)) {
    if (${JSON.stringify(build)} === "verbose-activation") process.stdout.write("x".repeat(700_000));
    fs.appendFileSync(path.join(state, "enabled"), id + "\\n");
  }
} else {
  process.title = "openclaw-connect";
  const enabledFile = path.join(state, "enabled");
  const enabledPlugins = fs.existsSync(enabledFile) ? fs.readFileSync(enabledFile, "utf8").trim().split("\\n") : [];
  fs.writeFileSync(path.join(state, "launch.json.tmp"), JSON.stringify({ build: ${JSON.stringify(build)}, args, cli: process.argv[1], token: process.env.CRABBOX_WORKER_BOOTSTRAP_TOKEN, setupCode: process.env.CRABBOX_WORKER_SETUP_CODE, tool: process.platform !== "win32" ? execFileSync("bootstrap-tool-fixture", {encoding:"utf8"}).trim() : undefined, environment: { DISPLAY: process.env.DISPLAY, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR }, enabledPlugins }));
  // Existence signals readiness only after the child publishes complete JSON.
  fs.renameSync(path.join(state, "launch.json.tmp"), path.join(state, "launch.json"));
  sendReceipt(state, "launched:" + process.pid + ":ready");
  const desktopReady = path.join(process.env.HOME, "desktop-ready");
  if (fs.existsSync(desktopReady)) fs.writeFileSync(desktopReady, "ready\\n");
  setInterval(() => {}, 60000);
}
`,
  );
  const tools = path.join(packageRoot, "dist", "worker-tools", "bin");
  fs.mkdirSync(tools, { recursive: true });
  fs.writeFileSync(path.join(tools, "bootstrap-tool-fixture"), "#!/bin/sh\necho verified-tool\n", {
    mode: 0o755,
  });
  const dependency = path.join(packageRoot, "node_modules/runtime-fixture");
  fs.mkdirSync(dependency, { recursive: true });
  fs.writeFileSync(
    path.join(dependency, "package.json"),
    JSON.stringify({ name: "runtime-fixture", version: "1.0.0", type: "module", main: "index.js" }),
  );
  fs.writeFileSync(path.join(dependency, "index.js"), 'export const version = "2026.8.1";');
  fs.writeFileSync(
    path.join(packageRoot, "node-runtime.json"),
    JSON.stringify({
      buildId: "fixture-runtime-build",
      openclawVersion: "2026.8.1",
      install,
      platforms:
        install === "npm" ? [] : [{ platform: process.platform, arch: process.arch, prefix: "" }],
    }),
  );
  const inventory: Array<{ path: string; size: number; mode: number; sha256: string }> = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(file);
      } else {
        const contents = fs.readFileSync(file);
        inventory.push({
          path: "package/" + path.relative(packageRoot, file).split(path.sep).join("/"),
          size: contents.length,
          mode: fs.statSync(file).mode & 0o777,
          sha256: createHash("sha256").update(contents).digest("hex"),
        });
      }
    }
  };
  visit(packageRoot);
  fs.writeFileSync(path.join(packageRoot, "node-runtime.manifest.json"), JSON.stringify(inventory));
  const archive = path.join(root, "package.tgz");
  await tar.create({ cwd: root, file: archive, gzip: true }, ["package"]);
  return fs.readFileSync(archive);
}

export async function expectSetupPhases(
  result: Promise<{
    code: number | null;
    output: string;
    installation?: {
      nodeBootstrap: CrabboxWorkerNodeEnrollment["nodeBootstrap"];
      workerBundle: CrabboxWorkerNodeRuntimePreparation["workerBundle"];
    };
  }>,
) {
  const completed = await result;
  expect(completed.code).toBe(0);
  const lines = completed.output.trim().split("\n");
  let installationLines: string[] = [];
  if (completed.installation) {
    const { nodeBootstrap, workerBundle } = completed.installation;
    if (!nodeBootstrap.manifestSha256 || !nodeBootstrap.buildId) {
      throw new Error(
        "Runtime installation fixture requires an admitted inventory hash and build identity",
      );
    }
    readCrabboxRuntimeInstallation(completed.output, {
      nodeBootstrap: {
        sha256: nodeBootstrap.sha256,
        bytes: nodeBootstrap.bytes,
        manifestSha256: nodeBootstrap.manifestSha256,
        buildId: nodeBootstrap.buildId,
        openclawVersion: nodeBootstrap.openclawVersion,
        enabledPluginIds: nodeBootstrap.enabledPluginIds,
      },
      workerBundle: {
        sha256: workerBundle.sha256,
        bytes: workerBundle.bytes,
        packageRelativePath: workerBundle.packageRelativePath,
      },
    });
    // The canonical parser requires exactly one bounded receipt matching the admitted inputs.
    installationLines = lines.filter((line) => line.startsWith("OPENCLAW_RUNTIME_INSTALLED:"));
  }
  const timing = lines.filter((line) => line.startsWith('{"runnerPhases":'));
  expect(timing).toHaveLength(1);
  const phases = lines.filter(
    (line) => !timing.includes(line) && !installationLines.includes(line),
  );
  expect(phases.filter((line) => !/^CRABBOX_PHASE:[a-z.-]{1,80}$/.test(line))).toEqual([]);
  return phases.map((line) => line.slice("CRABBOX_PHASE:".length));
}

export async function runtimeManifestSha256(archive: Buffer): Promise<string | undefined> {
  let digest: string | undefined;
  const parser = tar.list({
    onReadEntry(entry) {
      if (entry.path !== "package/node-runtime.manifest.json") {
        return;
      }
      const hash = createHash("sha256");
      entry.on("data", (chunk: Buffer) => hash.update(chunk));
      entry.on("end", () => {
        digest = hash.digest("hex");
      });
    },
  });
  await pipeline(Readable.from([archive]), parser).catch(() => undefined);
  return digest;
}

/** Exercise the real npm subprocess and worker transfer settling through the generated installer. */
export function registerNpmEnrollmentFailureCases(fixture: {
  testHome: () => { home: string };
  serveArtifact: (
    archive: Buffer,
    options?: { hold?: Promise<void> },
  ) => Promise<{
    nodeBootstrap: CrabboxWorkerNodeEnrollment["nodeBootstrap"];
    requested: Promise<void>;
    closed: Promise<void>;
  }>;
  packageFixture: (build: string, postinstall: string, install: "npm") => Promise<Buffer>;
  enroll: (
    home: string,
    bootstrap: CrabboxWorkerNodeEnrollment["nodeBootstrap"],
    desktop: undefined,
    runtimeOnly: true,
    workerBundle: CrabboxWorkerNodeEnrollment["nodeBootstrap"] & { packageRelativePath: string },
  ) => Promise<{ code: number | null; output: string }>;
  cleanups: Array<() => Promise<void> | void>;
}) {
  it.each(["worker download", "npm installation"] as const)(
    "settles started work after %s fails before removing staging files",
    async (failure) => {
      const { home } = fixture.testHome();
      const postinstallResponse = Promise.withResolvers<void>();
      const postinstall = await fixture.serveArtifact(Buffer.from("finish"), {
        hold: postinstallResponse.promise,
      });
      const finished = path.join(home, "postinstall-complete");
      const served = await fixture.serveArtifact(
        await fixture.packageFixture(
          "preparation-failure",
          `
require("node:http").get(${JSON.stringify(postinstall.nodeBootstrap.url)}, (response) => {
  response.resume();
  response.once("end", () => {
    require("node:fs").writeFileSync("last-install-write", "complete");
    require("node:fs").writeFileSync(${JSON.stringify(finished)}, "complete");
    if (${JSON.stringify(failure)} === "npm installation") process.exit(17);
  });
});`,
          "npm",
        ),
      );
      const nodeBootstrap = { ...served.nodeBootstrap, install: "npm" as const };
      const workerResponse = Promise.withResolvers<void>();
      const worker = await fixture.serveArtifact(Buffer.from("synthetic worker archive"), {
        hold: workerResponse.promise,
      });
      const workerBundle = {
        ...worker.nodeBootstrap,
        packageRelativePath: `worker-artifacts/${worker.nodeBootstrap.sha256}.tgz`,
        ...(failure === "worker download" ? { bytes: worker.nodeBootstrap.bytes + 1 } : {}),
      };
      const preparation = fixture.enroll(home, nodeBootstrap, undefined, true, workerBundle);
      fixture.cleanups.push(async () => {
        workerResponse.resolve();
        postinstallResponse.resolve();
        await preparation;
      });
      try {
        await Promise.all([postinstall.requested, worker.requested]);
        if (failure === "worker download") {
          workerResponse.resolve();
          await postinstall.closed;
          await preparation;
        } else {
          postinstallResponse.resolve();
          await worker.closed;
        }
      } finally {
        workerResponse.resolve();
        postinstallResponse.resolve();
        await preparation;
      }
      expect(await preparation).toMatchObject({
        code: 1,
        output: expect.stringContaining(
          failure === "worker download"
            ? "archive length does not match the Gateway"
            : "package installation failed (exit code 17)",
        ),
      });
      expect(fs.existsSync(finished)).toBe(failure === "npm installation");
      expect(fs.readdirSync(path.join(home, ".openclaw-worker", "node-runtimes"))).toEqual([]);
    },
    30_000,
  );
}
