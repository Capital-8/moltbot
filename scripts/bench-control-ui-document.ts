// Real document HTTP/auth owners; no Gateway CLI build, model, or real account.
// pnpm exec tsx scripts/bench-control-ui-document.ts --port 19671 --warm 11
// --serve --bundle-dir dist/control-ui serves the existing browser cold-load bench.
// --asset-burst --root-kind bundled|resolved measures synthetic concurrent asset reads.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { loadavg } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { buffer } from "node:stream/consumers";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import type { ControlUiRootState } from "../src/gateway/server-control-ui-root.js";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "19671" },
    warm: { type: "string", default: "11" },
    route: { type: "string", default: "/chat" },
    "bundle-dir": { type: "string" },
    serve: { type: "boolean", default: false },
    "asset-burst": { type: "boolean", default: false },
    "root-kind": { type: "string" },
    out: { type: "string" },
  },
});
const port = Number(values.port);
const warm = Number(values.warm);
const route = values.route;
const assetRootKind = values["root-kind"] ?? "bundled";
assert(Number.isInteger(port) && port >= 19600 && port <= 19699, "port must be 19600–19699");
assert(Number.isInteger(warm) && warm >= 1, "warm must be a positive integer");
assert(route === "/" || route === "/chat", "route must be / or /chat");
assert(assetRootKind === "bundled" || assetRootKind === "resolved", "Unknown --root-kind");
assert(!values["root-kind"] || values["asset-burst"], "--root-kind requires --asset-burst");
assert(
  !values["asset-burst"] || (!values.serve && !values["bundle-dir"]),
  "--asset-burst owns synthetic assets; exclude --serve and --bundle-dir",
);
const scratch = path.resolve(".local");
await mkdir(scratch, { recursive: true });
const root = await mkdtemp(path.join(scratch, "document-bench-"));
const stateDir = path.join(root, "state");
await mkdir(stateDir, { recursive: true });
// Install isolated selectors before importing any state/config owner.
process.env.OPENCLAW_STATE_DIR = stateDir;
const configPath = path.join(root, "openclaw.json");
process.env.OPENCLAW_CONFIG_PATH = configPath;
delete process.env.OPENCLAW_AGENT_DIR;
delete process.env.PI_CODING_AGENT_DIR;
const origin = `http://127.0.0.1:${port}`;
const email = "document-operator@example.test";
const trustedProxy = { userHeader: "x-forwarded-user", allowLoopback: true };
const proxyHeaders = {
  "x-forwarded-for": "203.0.113.42",
  "x-forwarded-proto": "https",
  "x-forwarded-user": email,
  "x-openclaw-scopes": "operator.admin",
};
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const limitations = [
  "Measures the actual Gateway document handler and trusted-proxy authorization at / and /chat; canonical /chat/... session-entry admission is excluded.",
  "A loopback fixture injects a fixed synthetic proxy user before real ingress/authentication; no identity provider or WebSocket server runs.",
  "Cold is the first HTTP document after fixture setup; profile creation and server imports precede it. Parallel preparation stages overlap within total.",
];

const { setRuntimeConfigSnapshot } = await import("../src/config/runtime-snapshot.js");
const { createEmptyPluginRegistry } = await import("../src/plugins/registry-empty.js");
const { createPluginRecord } = await import("../src/plugins/status.test-helpers.js");
const { setActivePluginRegistry, clearActivePluginRegistry } =
  await import("../src/plugins/runtime.js");
const { ensureCanonicalUserProfileForEmail } = await import("../src/state/user-profile-writes.js");
const { setCanonicalUserPreferences } = await import("../src/state/user-preferences.js");
const { prepareUserProfileCatalog } = await import("../src/state/user-profile-list.js");
const { cleanupSessionStateForTest } = await import("../src/test-utils/session-state-cleanup.js");
const { onTrustedInternalDiagnosticEvent, waitForDiagnosticEventsDrained } =
  await import("../src/infra/diagnostic-events.js");
const { decodeHtmlEntities } = await import("../src/shared/html-entities.js");
const { CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE } =
  await import("../src/gateway/control-ui-bootstrap-contract.js");
const { createGatewayHttpServer } = await import("../src/gateway/server-http.js");
const registry = createEmptyPluginRegistry();
let server: ReturnType<typeof createGatewayHttpServer> | undefined;
let catalog: Awaited<ReturnType<typeof prepareUserProfileCatalog>> | undefined;
let unsubscribe: (() => void) | undefined;

try {
  const entries: NonNullable<OpenClawConfig["agents"]>["entries"] = {};
  const pixel = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=",
    "base64",
  );
  for (let index = 0; index < 6; index++) {
    const id = index === 0 ? "main" : `fixture-${index}`;
    const workspace = path.join(root, "workspaces", id);
    await mkdir(path.join(workspace, "avatars"), { recursive: true });
    await mkdir(path.join(stateDir, "agents", id, "agent"), { recursive: true });
    await writeFile(path.join(workspace, "avatars", "operator.png"), pixel);
    await writeFile(
      path.join(workspace, "IDENTITY.md"),
      `# Identity\n- Name: Fixture ${id}\n- Emoji: 🔭\n- Avatar: avatars/operator.png\n`,
    );
    entries[id] = {
      workspace,
      identity: { name: `Fixture ${id}`, emoji: "🔭", avatar: "avatars/operator.png" },
    };
  }
  for (let index = 0; index < 7; index++) {
    const id = `document-plugin-${index}`;
    const rootDir = path.join(root, "plugins", id);
    const controlUi = { entry: "dist/control-ui/index.js", styles: ["dist/control-ui/style.css"] };
    await mkdir(path.join(rootDir, "dist/control-ui"), { recursive: true });
    await writeFile(
      path.join(rootDir, controlUi.entry),
      `export default { id: ${JSON.stringify(id)}, activate() {} };\n`,
    );
    await writeFile(
      path.join(rootDir, "dist/control-ui/style.css"),
      ".document-fixture { color: inherit; }\n",
    );
    await writeFile(
      path.join(rootDir, "openclaw.plugin.json"),
      JSON.stringify({
        id,
        controlUi,
        uiCapabilities: ["page", "widget"],
        configSchema: { type: "object", additionalProperties: false },
      }),
    );
    const record = createPluginRecord({
      id,
      origin: "bundled",
      rootDir,
      source: path.join(rootDir, "index.ts"),
      controlUi,
      uiCapabilities: ["page", "widget"],
    });
    registry.plugins.push(record);
    registry.controlUiDescriptors.push({
      pluginId: id,
      source: record.source,
      descriptor: { id: "summary", surface: "widget", label: `Fixture ${index}` },
    });
  }
  const config: OpenClawConfig = {
    agents: { entries },
    gateway: {
      auth: { mode: "trusted-proxy", trustedProxy },
      trustedProxies: ["127.0.0.1"],
      terminal: { enabled: false },
      controlUi: { allowedOrigins: [origin] },
      roles: {
        default: "operator",
        definitions: {
          operator: { agents: "*", sessions: { others: "view" }, scopes: ["operator.admin"] },
        },
      },
    },
  };
  await writeFile(configPath, JSON.stringify(config));
  setRuntimeConfigSnapshot(config, config);
  setActivePluginRegistry(registry);
  const profile = await ensureCanonicalUserProfileForEmail(email);
  const saved = await setCanonicalUserPreferences(profile.id, { "ui.themeMode": "dark" });
  assert(saved?.ok, "synthetic preferences must be stored through their owner");
  catalog = await prepareUserProfileCatalog();
  const bundleDir = values["bundle-dir"]
    ? path.resolve(values["bundle-dir"])
    : path.join(root, "control-ui");
  if (!values["bundle-dir"]) {
    await mkdir(bundleDir);
    const shell =
      "<!doctype html><html><head><title>Synthetic document fixture</title></head><body><openclaw-app></openclaw-app></body></html>";
    await writeFile(
      path.join(bundleDir, "index.html"),
      shell.replace(
        "</head>",
        `<!--${"x".repeat(34_858 - Buffer.byteLength(shell) - 7)}--></head>`,
      ),
    );
  }
  const index = await readFile(path.join(bundleDir, "index.html"));
  const traces = new Map<string, Record<string, number>>();
  const observations: Record<string, number>[] = [];
  let ordinal = 0;
  unsubscribe = onTrustedInternalDiagnosticEvent(
    (event, metadata) => {
      if (
        !metadata.trusted ||
        event.type !== "diagnostic.phase.completed" ||
        !event.name.startsWith("control-ui.document.")
      ) {
        return;
      }
      const key = event.trace?.traceId ?? "document";
      const stages = traces.get(key) ?? {};
      const stage = event.name.slice("control-ui.document.".length);
      stages[stage] = event.durationMs ?? 0;
      traces.set(key, stages);
      if (stage === "total") {
        ordinal++;
        if (!values.serve) {
          observations.push(stages);
        }
        traces.delete(key);
        if (values.serve) {
          emit({ type: "document-stages", ordinal, stagesMs: stages });
        }
      }
    },
    { include: ["diagnostic.phase.completed"] },
  );
  const auth = { mode: "trusted-proxy" as const, trustedProxy, allowTailscale: false };
  const controlUiRoot: Extract<ControlUiRootState, { kind: "bundled" | "resolved" }> = {
    kind: values["asset-burst"] ? assetRootKind : "bundled",
    path: bundleDir,
    realPath: await realpath(bundleDir),
  };
  const listener = createGatewayHttpServer({
    clients: new Set(),
    controlUiEnabled: true,
    controlUiBasePath: "",
    controlUiRoot,
    openAiChatCompletionsEnabled: false,
    openResponsesEnabled: false,
    handleHooksRequest: async () => false,
    resolvedAuth: auth,
    getResolvedAuth: () => auth,
    getRuntimeConfig: () => config,
    isTerminalEnabled: () => false,
  });
  server = listener;
  // This is the synthetic identity-provider boundary, outside the measured handler.
  listener.prependListener("request", (req) => Object.assign(req.headers, proxyHeaders));
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(port, "127.0.0.1", () => {
      listener.off("error", reject);
      resolve();
    });
  });
  const fixture = {
    origin,
    route,
    agents: 6,
    plugins: 7,
    auth: "synthetic-trusted-proxy",
    indexBytes: index.byteLength,
    indexSha256: sha256(index),
    realBundle: Boolean(values["bundle-dir"]),
    limitations,
  };
  if (values["asset-burst"]) {
    const { startGatewayBenchDiagnostics } = await import("./lib/gateway-bench-diagnostics.ts");
    const { getTrackedWorkerLifecycleSnapshot } = await import("../src/infra/worker-cpu.js");
    const { readControlUiRootAsset } = await import("../src/gateway/server-control-ui-root.js");
    const directory = path.join(bundleDir, "assets");
    await mkdir(directory);
    // A large UI chunk ahead of seven small runtime modules exposes head-of-line waiting.
    // Generate code-shaped text so negotiated gzip reads have realistic compression work.
    const sizes = [1024 * 1024, ...Array<number>(7).fill(8 * 1024)];
    const payload = (size: number, revision: number) =>
      Buffer.from(
        Array.from(
          { length: Math.ceil(size / 32) },
          (_, index) =>
            `export const v${index} = "${revision}-${((index * 2654435761) >>> 0).toString(36)}";\n`,
        )
          .join("")
          .slice(0, size),
      );
    const samples = [];
    // Match ordinary cold-load proof: prime only the document, never a second worker.
    await readControlUiRootAsset(controlUiRoot, "index.html", true);
    for (const encoding of ["identity", "gzip"] as const) {
      const assets = sizes.map((size, index) => {
        const body = payload(size, 0);
        return { name: `burst-${encoding}-${index}.js`, body, compressed: gzipSync(body) };
      });
      await Promise.all(
        assets.map(async (asset) => {
          await writeFile(path.join(directory, asset.name), asset.body);
          await writeFile(path.join(directory, `${asset.name}.gz`), asset.compressed);
        }),
      );
      const measure = async (temperature: string) => {
        const finishDiagnostics = startGatewayBenchDiagnostics();
        const workersBefore = getTrackedWorkerLifecycleSnapshot();
        const hostLoadBefore = loadavg();
        const cpuBefore = process.cpuUsage();
        const began = performance.now();
        const results = await Promise.allSettled(
          assets.map(async (asset) => {
            const started = performance.now();
            const response = await new Promise<import("node:http").IncomingMessage>(
              (resolve, reject) => {
                request(
                  `${origin}/assets/${asset.name}`,
                  { agent: false, headers: { "accept-encoding": encoding } },
                  resolve,
                )
                  .once("error", reject)
                  .end();
              },
            );
            const responseStartMs = performance.now() - started;
            const body = await buffer(response);
            return {
              name: asset.name,
              responseStartMs,
              responseEndMs: performance.now() - started,
              completedAtMs: performance.now() - began,
              status: response.statusCode,
              encoding: response.headers["content-encoding"] ?? "identity",
              body,
            };
          }),
        );
        const elapsedMs = performance.now() - began;
        const cpu = process.cpuUsage(cpuBefore);
        const diagnostics = finishDiagnostics();
        const taskCount = diagnostics.groups
          .filter(
            (group) =>
              group.channel === "openclaw.worker.task" &&
              group.operation.startsWith("control-ui-file.worker."),
          )
          .reduce((sum, group) => sum + group.count, 0);
        const cached = assetRootKind === "bundled" && temperature === "repeat";
        const readsPerAsset = assetRootKind === "bundled" && encoding === "gzip" ? 2 : 1;
        assert.equal(taskCount, cached ? 0 : assets.length * readsPerAsset);
        const records = results.map((result, index) => {
          if (result.status === "rejected") {
            throw result.reason;
          }
          const { body, ...response } = result.value;
          const expectedEncoding = encoding === "gzip" && assetRootKind === "bundled";
          const expected = expectedEncoding ? assets[index]!.compressed : assets[index]!.body;
          assert.equal(response.status, 200, `${response.name}: HTTP status`);
          assert.equal(response.encoding, expectedEncoding ? "gzip" : "identity");
          assert(body.equals(expected), `${response.name}: response bytes changed`);
          return { ...response, bytes: body.byteLength, sha256: sha256(body) };
        });
        return {
          encoding,
          temperature,
          elapsedMs,
          cpuMs: { user: cpu.user / 1000, system: cpu.system / 1000 },
          taskCount,
          hostLoad: { before: hostLoadBefore, after: loadavg() },
          workersBefore,
          workersAfter: getTrackedWorkerLifecycleSnapshot(),
          diagnostics,
          responses: records,
        };
      };
      samples.push(await measure("cold-assets"));
      for (let repeat = 0; repeat < warm; repeat++) {
        samples.push(await measure("repeat"));
      }
      if (assetRootKind === "resolved") {
        const changed = assets[1]!;
        changed.body = payload(sizes[1]!, 1);
        changed.compressed = gzipSync(changed.body);
        await writeFile(path.join(directory, changed.name), changed.body);
        await writeFile(path.join(directory, `${changed.name}.gz`), changed.compressed);
        samples.push(await measure("rewritten"));
      }
    }
    const report = {
      type: "asset-burst-report",
      rootKind: assetRootKind,
      sizes,
      samples,
      limitations: [
        "Synthetic concurrent HTTP reads after an index-only prime; no browser or network shaping.",
        "Cold means uncached asset names, not cold filesystem pages. Gzip fixture generation precedes timing.",
        "Process CPU includes all Gateway fixture workers; byte validation and hashing follow timing.",
      ],
    };
    if (values.out) {
      await writeFile(path.resolve(values.out), `${JSON.stringify(report, null, 2)}\n`);
    }
    emit(report);
  } else if (values.serve) {
    emit({ type: "ready", ...fixture });
    await new Promise<void>((resolve) => {
      const stop = () => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        resolve();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
  } else {
    const read = async (requestPath: string) => {
      const startedAt = performance.now();
      const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
        request(`${origin}${requestPath}`, { agent: false }, resolve).once("error", reject).end();
      });
      const responseStartMs = performance.now() - startedAt;
      const body = await buffer(response);
      assert.equal(response.statusCode, 200, body.toString());
      await waitForDiagnosticEventsDrained();
      return { body, responseStartMs, responseEndMs: performance.now() - startedAt };
    };
    const samples = [];
    let firstPayload: unknown;
    for (let run = 0; run <= warm; run++) {
      const before = observations.length;
      const response = await read(route);
      const match = new RegExp(`${CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE}="([^"]*)"`, "u").exec(
        response.body.toString(),
      );
      assert(match, "authenticated document must contain bootstrap config");
      const encodedPayload = match[1];
      assert(encodedPayload);
      const payload: unknown = JSON.parse(decodeHtmlEntities(encodedPayload));
      assert(isRecord(payload));
      assert.equal(payload.assistantName, "Fixture main");
      assert.equal(payload.assistantAvatarStatus, "local");
      assert(Array.isArray(payload.pluginControlUiModules));
      assert.equal(payload.pluginControlUiModules.length, 7);
      assert(isRecord(payload.preferences));
      assert.equal(payload.preferences.profileId, profile.id);
      assert(isRecord(payload.preferences.entries));
      assert.equal(payload.preferences.entries["ui.themeMode"], "dark");
      if (run === 0) {
        firstPayload = payload;
      } else {
        assert.deepEqual(
          payload,
          firstPayload,
          "same inputs must produce identical bootstrap payloads",
        );
      }
      samples.push({
        run,
        temperature: run === 0 ? "first-http" : "warm",
        responseStartMs: response.responseStartMs,
        responseEndMs: response.responseEndMs,
        bytes: response.body.byteLength,
        sha256: sha256(response.body),
        payloadSha256: sha256(JSON.stringify(payload)),
        stagesMs: observations.slice(before),
      });
    }
    const endpoint = await read("/control-ui-config.json");
    assert.deepEqual(
      JSON.parse(endpoint.body.toString()),
      firstPayload,
      "document and canonical endpoint bootstrap must agree",
    );
    const report = { type: "report", ...fixture, payloadCorrect: true, samples };
    if (values.out) {
      await writeFile(path.resolve(values.out), `${JSON.stringify(report, null, 2)}\n`);
    }
    emit(report);
  }
} finally {
  if (server?.listening) {
    const listener = server;
    listener.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      listener.close((error) => (error ? reject(error) : resolve()));
    });
  }
  unsubscribe?.();
  catalog?.release();
  await clearActivePluginRegistry(registry);
  await cleanupSessionStateForTest({ stateDir, rootPath: root });
  await rm(root, { recursive: true, force: true });
}
