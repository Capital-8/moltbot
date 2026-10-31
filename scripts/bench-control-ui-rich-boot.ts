import { readFile, mkdir, writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import {
  CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE,
  CONTROL_UI_BOOTSTRAP_CONFIG_PATH,
} from "../src/gateway/control-ui-bootstrap-contract.ts";
import {
  installMockGateway,
  controlUiSessionUrl,
  controlUiBundledGatewayUrl,
  createControlUiMockBootstrapConfig,
  resolvePlaywrightChromiumExecutablePath,
} from "../ui/src/test-helpers/control-ui-e2e.ts";
import { startControlUiBenchGatewayServer } from "./lib/control-ui-bench-gateway-server.ts";
import { startControlUiBenchProxy } from "./lib/control-ui-bench-proxy.ts";
import { summarizeScriptCoverage } from "./lib/control-ui-cold-load-trace.ts";
import { emulateNavigationWorkerNetwork } from "./lib/control-ui-navigation-network.ts";
import {
  createRichBootHistory,
  RICH_BOOT_IMAGE,
  emitRichBootToolResult,
  inspectRichBootBundles,
  installRichBootReadiness,
  readRichBootRunnerIdentity,
  richBootCpuDelta,
  summarizeRichBootResources,
} from "./lib/control-ui-rich-boot-fixture.ts";
import {
  qualifyRouteNetworkClock,
  type RouteNetworkObservation,
} from "./lib/control-ui-route-network.ts";

// Fresh contexts isolate rich boot/first-use; coverage and admission runs are not timing cohorts.
const { values } = parseArgs({
  options: {
    "bundle-dir": { type: "string" },
    "compare-bundle-dir": { type: "string" },
    output: { type: "string", default: ".artifacts/control-ui-rich-boot" },
    pairs: { type: "string", default: "20" },
    fixture: { type: "string", default: "rich-history" },
    counterbalance: { type: "boolean", default: false },
    coverage: { type: "boolean", default: false },
    "fixture-now-ms": { type: "string" },
    "harness-manifest": { type: "string" },
    admission: { type: "string" },
    "admission-delay-ms": { type: "string", default: "5000" },
    "network-latency-ms": { type: "string", default: "0" },
    "service-worker": { type: "boolean", default: false },
    http2: { type: "boolean", default: false },
    "compare-http2": { type: "boolean", default: false },
    "compare-delivery-hints": { type: "boolean", default: false },
    "typeface-profile": { type: "string", default: "claw" },
  },
});
if (!values["bundle-dir"] || !values["compare-bundle-dir"]) {
  throw new Error("bundle-dir and compare-bundle-dir are required");
}
const output = path.resolve(values.output, new Date().toISOString().replaceAll(":", "-"));
const base = path.resolve(values["bundle-dir"]);
const head = path.resolve(values["compare-bundle-dir"]);
const pairs = Number(values.pairs);
const networkLatencyMs = Number(values["network-latency-ms"]);
const fixture = values.fixture;
const now = Number(values["fixture-now-ms"] ?? Date.now());
const admissionDelayMs = Number(values["admission-delay-ms"]);
if (!["rich-history", "initial-rich", "mixed-history", "first-rich-arrival"].includes(fixture)) {
  throw new Error(
    "fixture must be rich-history, initial-rich, mixed-history, or first-rich-arrival",
  );
}
if (
  values.admission &&
  (!["hold", "fail"].includes(values.admission) || fixture !== "first-rich-arrival" || pairs !== 1)
) {
  throw new Error("admission must be hold or fail, with first-rich-arrival and pairs=1");
}
if (
  !Number.isSafeInteger(now) ||
  !Number.isSafeInteger(admissionDelayMs) ||
  admissionDelayMs < 1000
) {
  throw new Error("fixture-now-ms must be an integer; admission-delay-ms must be at least 1000");
}
if (!["claw", "dash", "system"].includes(values["typeface-profile"])) {
  throw new Error("typeface-profile must be claw, dash, or system");
}
const typefacePreferences = {
  theme: values["typeface-profile"] === "dash" ? "dash" : "claw",
  themeMode: "light",
  ...(values["typeface-profile"] === "system" ? { fontUi: "system", fontChat: "system" } : {}),
};
if (
  !Number.isSafeInteger(pairs) ||
  pairs < 1 ||
  !Number.isFinite(networkLatencyMs) ||
  networkLatencyMs < 0
) {
  throw new Error("pairs must be a positive integer and network-latency-ms must be nonnegative");
}
const variants = [
  ["base", base],
  ["control", base],
  ["head", head],
] as const;
const sessionKey = "agent:main:dashboard:rich-risk-proof";
const finalText = "The completed rich run is ready.";
const activeText = "The active run is inspecting the synthetic layout.";
const { historyMessages, oldMedia } = createRichBootHistory(fixture, now, sessionKey, finalText);
const runner = await readRichBootRunnerIdentity(
  fileURLToPath(import.meta.url),
  values["harness-manifest"],
);
const { bundles, richFamily } = await inspectRichBootBundles(
  base,
  head,
  fixture !== "rich-history" || values.coverage || Boolean(values.admission),
);
const richAsset = richFamily?.asset;
await mkdir(output, { recursive: true });
const server = await startControlUiBenchGatewayServer(base);
const proxy =
  values.http2 || values["compare-http2"]
    ? await startControlUiBenchProxy(server.baseUrl)
    : undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let workerNetwork: Awaited<ReturnType<typeof emulateNavigationWorkerNetwork>> | undefined;
const results: unknown[] = [];
try {
  browser = await chromium.launch({
    executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
  });
  if (values["service-worker"]) {
    workerNetwork = await emulateNavigationWorkerNetwork(browser, {
      latency: networkLatencyMs,
      downloadThroughput: networkLatencyMs ? 1_250_000 : -1,
      uploadThroughput: -1,
    });
  }
  for (let pair = 0; pair < pairs; pair++) {
    const orders = [
      [0, 1, 2],
      [2, 0, 1],
      [1, 2, 0],
    ];
    const order = values.admission
      ? [2]
      : values.counterbalance
        ? orders[pair % orders.length]!
        : orders[0]!;
    for (const [position, variantIndex] of order.entries()) {
      const [variant, bundle] = variants[variantIndex]!;
      const bundleInfo = bundles[variant === "head" ? 1 : 0]!;
      const baseUrl =
        proxy && (!values["compare-http2"] || variant === "head") ? proxy.baseUrl : server.baseUrl;
      await server.selectBuild(bundle);
      server.setPreloadHeadersEnabled(!values["compare-delivery-hints"] || variant === "head");
      const buildId = bundleInfo.build.buildId;
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1100 },
        colorScheme: "light",
        serviceWorkers: values["service-worker"] ? "allow" : "block",
        ignoreHTTPSErrors: Boolean(proxy),
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      try {
        const scenario = {
          methodResponses: {
            "config.get": {
              appliedConfigHash: "synthetic-typography",
              configRevisionHash: "synthetic-typography",
              hash: "synthetic-typography",
              config: { ui: { prefs: typefacePreferences } },
              raw: JSON.stringify({ ui: { prefs: typefacePreferences } }),
              issues: [],
              valid: true,
            },
          },
          serverBuildId: buildId,
          sessionKey,
          historyMessages: historyMessages.map((message, index) =>
            index === 3 && fixture === "initial-rich"
              ? {
                  role: "assistant",
                  content: [
                    { type: "text", text: finalText },
                    {
                      type: "image",
                      url: `${baseUrl}/__rich-proof.png`,
                      alt: "Synthetic initial rich image",
                      width: 32,
                      height: 32,
                    },
                  ],
                  phase: "final_answer",
                  runId: "completed-risk",
                  timestamp: now - 2000,
                }
              : message === historyMessages[1] && fixture === "mixed-history"
                ? {
                    ...oldMedia,
                    content: `Old synthetic image.\nMEDIA:${baseUrl}/__rich-proof.png`,
                  }
                : message,
          ),
          ...(fixture === "rich-history" || fixture === "initial-rich"
            ? {
                inFlightRun: {
                  runId: "active-risk",
                  text: activeText,
                  startedAt: now,
                },
              }
            : {}),
          sessionInfo: {
            key: sessionKey,
            hasActiveRun: fixture === "rich-history" || fixture === "initial-rich",
            activeRunIds:
              fixture === "rich-history" || fixture === "initial-rich" ? ["active-risk"] : [],
            status: fixture === "rich-history" || fixture === "initial-rich" ? "running" : "idle",
          },
        };
        let richRequestAt: number | undefined;
        let richResponseSeen = false;
        const heldCode =
          values.admission === "hold" && richAsset
            ? await readFile(path.join(head, richAsset))
            : undefined;
        server.setFixtureReader((pathname) =>
          // A reachable document triggers the existing automatic stale-chunk recovery.
          // Keep its probe unavailable until the manual outage-recovery step below.
          values.admission === "fail" && pathname === "/index.html"
            ? { body: "Synthetic document outage", contentType: "text/plain", status: 503 }
            : values.admission && richAsset && pathname === `/${richAsset}`
              ? ((richRequestAt = Date.now()),
                {
                  body: heldCode ?? "Synthetic rich asset failure",
                  contentType: "text/javascript",
                  delayMs: values.admission === "hold" ? admissionDelayMs : undefined,
                  status: values.admission === "fail" ? 503 : 200,
                })
              : pathname === "/__rich-proof.png"
                ? {
                    body: RICH_BOOT_IMAGE,
                    contentType: "image/png",
                  }
                : pathname.endsWith(CONTROL_UI_BOOTSTRAP_CONFIG_PATH)
                  ? {
                      body: JSON.stringify(createControlUiMockBootstrapConfig(scenario)),
                      contentType: "application/json",
                    }
                  : undefined,
        );
        await page.addInitScript(
          ({ gatewayUrl, prefs }) => {
            if (location.origin !== "null") {
              localStorage.setItem(
                `openclaw.control.settings.v1:${gatewayUrl}`,
                JSON.stringify({ gatewayUrl, ...prefs }),
              );
            }
          },
          { gatewayUrl: controlUiBundledGatewayUrl(baseUrl), prefs: typefacePreferences },
        );
        const gateway = await installMockGateway(page, scenario);
        // HTTP interception disables the browser cache, including speculative
        // preload reuse. The isolated server owns the synthetic bootstrap read.
        await page.unrouteAll();
        const initOptions = {
          bootstrap: JSON.stringify(createControlUiMockBootstrapConfig(scenario)),
          attribute: CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE,
          finalText,
          activeText,
          fixture,
        };
        await page.addInitScript({
          content: `;(() => { const __name = (fn) => fn; (${installRichBootReadiness.toString()})(${JSON.stringify(initOptions)}); })();`,
        });
        const cdp = await context.newCDPSession(page);
        const networkRequests: RouteNetworkObservation[] = [];
        const pendingRequests = new Map<string, RouteNetworkObservation>();
        cdp.on("Network.requestWillBeSent", (event) => {
          const request = {
            requestId: event.requestId,
            url: event.request.url,
            timestampSeconds: event.timestamp,
          };
          networkRequests.push(request);
          pendingRequests.set(event.requestId, request);
        });
        cdp.on("Network.loadingFinished", (event) => {
          const request = pendingRequests.get(event.requestId);
          if (request) {
            request.finishedTimestampSeconds = event.timestamp;
            request.wireBytes = event.encodedDataLength;
          }
        });
        cdp.on("Network.loadingFailed", (event) => {
          const request = pendingRequests.get(event.requestId);
          if (request) {
            request.failed = event.errorText;
          }
        });
        const responses: Array<{
          url: string;
          protocol?: string;
          connectionId?: number;
          status: number;
          fromServiceWorker: boolean;
          headers: Record<string, string>;
        }> = [];
        cdp.on("Network.responseReceived", ({ response }) => {
          if (richAsset && new URL(response.url).pathname === `/${richAsset}`) {
            richResponseSeen = true;
          }
          responses.push({
            url: response.url,
            protocol: response.protocol,
            connectionId: response.connectionId,
            status: response.status,
            fromServiceWorker: response.fromServiceWorker ?? false,
            headers: Object.fromEntries(
              Object.entries(response.headers)
                .filter(([name]) => /^(cache-control|content-encoding|vary|link)$/i.test(name))
                .map(([name, value]) => [name.toLowerCase(), value]),
            ),
          });
        });
        const earlyHints: unknown[] = [];
        cdp.on("Network.responseReceivedEarlyHints", (event) => earlyHints.push(event));
        await cdp.send("Network.enable");
        let workerSetup:
          | { scriptUrl?: string; navigationPreloadEnabled?: boolean; nativeAuthRequests?: number }
          | undefined;
        if (values["service-worker"]) {
          await page.goto(controlUiSessionUrl(baseUrl, sessionKey));
          await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
          workerSetup = await page.evaluate(async () => {
            const registration = await navigator.serviceWorker.ready;
            return {
              scriptUrl: registration.active?.scriptURL,
              navigationPreloadEnabled: (await registration.navigationPreload?.getState())?.enabled,
            };
          });
          const nativeAuthUrl = new URL(controlUiSessionUrl(baseUrl, sessionKey));
          nativeAuthUrl.searchParams.set("openclaw_http_auth", "1");
          server.requests.length = 0;
          await page.goto(nativeAuthUrl.href);
          workerSetup.nativeAuthRequests = server.requests.filter(
            (request) => request.url === nativeAuthUrl.pathname + nativeAuthUrl.search,
          ).length;
          if (workerSetup.nativeAuthRequests !== 1) {
            throw new Error(
              `Native auth navigation sent ${workerSetup.nativeAuthRequests} requests`,
            );
          }
          // Retire the warm document before stopping its worker: its resume and
          // offline-cache probes must not restart it during cold-state setup.
          await page.goto("about:blank");
          // Own browser/profile only: exercise a stopped worker with cold assets.
          await cdp.send("ServiceWorker.enable");
          await cdp.send("ServiceWorker.stopAllWorkers");
          await cdp.send("Storage.clearDataForOrigin", {
            origin: baseUrl,
            storageTypes: "cache_storage,indexeddb,local_storage",
          });
        }
        await cdp.send("Network.clearBrowserCache");
        await cdp.send("Network.setCacheDisabled", { cacheDisabled: false });
        await cdp.send("Network.emulateNetworkConditions", {
          offline: false,
          latency: networkLatencyMs,
          downloadThroughput: networkLatencyMs ? 1_250_000 : -1,
          uploadThroughput: -1,
        });
        await cdp.send("Performance.enable", { timeDomain: "threadTicks" });
        const captureCoverage = values.coverage || Boolean(values.admission);
        if (captureCoverage) {
          await cdp.send("Profiler.enable");
          await page.coverage.startJSCoverage({ resetOnNavigation: true });
        }
        const before = (await cdp.send("Performance.getMetrics")).metrics;
        const hostLoad = loadavg();
        responses.length = 0;
        networkRequests.length = 0;
        pendingRequests.clear();
        earlyHints.length = 0;
        server.requests.length = 0;
        const workerRequestStart = workerNetwork?.snapshot().requests.length ?? 0;
        await page.goto(controlUiSessionUrl(baseUrl, sessionKey), {
          waitUntil: "domcontentloaded",
        });
        if (!(await page.evaluate(() => Reflect.has(window, "__richRiskReadiness")))) {
          throw new Error(`Readiness initializer failed: ${errors.join("; ")}`);
        }
        await page.waitForFunction(
          () => {
            const readiness = Reflect.get(window, "__richRiskReadiness");
            return Boolean(readiness?.readyMs);
          },
          undefined,
          { timeout: 30000 },
        );
        const bootAfter = (await cdp.send("Performance.getMetrics")).metrics;
        let bootCoverage: Array<{ url: string }> | undefined;
        let preArrivalCoverage: Array<{ url: string }> | undefined;
        if (captureCoverage && fixture === "first-rich-arrival") {
          bootCoverage = (await cdp.send("Profiler.getBestEffortCoverage")).result;
          if (
            variant === "head" &&
            bootCoverage.some((entry) => new URL(entry.url, baseUrl).pathname === `/${richAsset}`)
          ) {
            throw new Error("Rich family entered V8 during plain boot");
          }
        }
        let arrivalBefore: typeof bootAfter | undefined;
        let admissionReceipt: unknown;
        let recoveryMessage: Awaited<ReturnType<typeof emitRichBootToolResult>> | undefined;
        const latestText = "Latest synthetic final after the rich event.";
        if (fixture === "first-rich-arrival") {
          // No idle wait: begin the ordinary send as soon as the semantic boot boundary passes.
          await page
            .locator(".agent-chat__composer-combobox textarea")
            .fill("Inspect the synthetic file.");
          await page.getByRole("button", { name: "Send message", exact: true }).click();
          const request = await gateway.waitForRequest("chat.send");
          const runId =
            request.params &&
            typeof request.params === "object" &&
            "idempotencyKey" in request.params
              ? request.params.idempotencyKey
              : undefined;
          if (typeof runId !== "string") {
            throw new Error("Synthetic send has no run ID");
          }
          if (captureCoverage) {
            preArrivalCoverage = (await cdp.send("Profiler.getBestEffortCoverage")).result;
            if (
              variant === "head" &&
              preArrivalCoverage.some(
                (entry) => new URL(entry.url, baseUrl).pathname === `/${richAsset}`,
              )
            ) {
              throw new Error("Rich family entered V8 before the first rich event");
            }
          }
          if (values.admission) {
            await page
              .getByRole("button", { name: "Reply to message", exact: true })
              .last()
              .focus();
            await page.evaluate(() => {
              const scroller = document.querySelector(".chat-thread");
              Object.assign(window, {
                __richRetained: {
                  rows: [...document.querySelectorAll("[data-virtual-row-key]")],
                  focus: document.activeElement,
                  height: scroller?.scrollHeight,
                },
              });
            });
          }
          arrivalBefore = (await cdp.send("Performance.getMetrics")).metrics;
          await page.evaluate(() => {
            Reflect.get(window, "__richRiskReadiness").arrivalStartedMs = performance.now();
          });
          await emitRichBootToolResult(gateway, {
            sessionKey,
            runId,
            now,
            messageSeq: historyMessages.length + 2,
            text: "Intermediate synthetic final.",
            includeActivity: true,
            imageUrl: `${baseUrl}/__rich-proof.png`,
          });
          if (values.admission) {
            await page.waitForFunction(() =>
              Boolean(document.querySelector(".chat-transcript-preparation")),
            );
            if (richRequestAt === undefined) {
              throw new Error("Admission never requested the rich asset");
            }
            recoveryMessage = await emitRichBootToolResult(gateway, {
              sessionKey,
              runId,
              now,
              messageSeq: historyMessages.length + 3,
              text: latestText,
              includeActivity: false,
              imageUrl: `${baseUrl}/__rich-proof.png`,
            });
            const retained = await page.evaluate(() => {
              const state = Reflect.get(window, "__richRetained");
              return {
                rows: state.rows.length,
                connected: state.rows.every((row: HTMLElement) => row.isConnected),
                focus: document.activeElement === state.focus,
                height: document.querySelector(".chat-thread")?.scrollHeight,
                originalHeight: state.height,
                leakedRich: Boolean(
                  document.querySelector(".chat-tool-msg-summary, .chat-work-group"),
                ),
              };
            });
            const observedAt = Date.now();
            admissionReceipt = {
              mode: values.admission,
              requestAt: richRequestAt,
              observedAt,
              responseSeen: richResponseSeen,
              delayMs: admissionDelayMs,
              retained,
            };
            if (
              !retained.rows ||
              !retained.connected ||
              !retained.focus ||
              retained.height !== retained.originalHeight ||
              retained.leakedRich
            ) {
              throw new Error("Admission did not retain the accepted rows, focus and extent");
            }
            if (
              values.admission === "hold" &&
              (richResponseSeen || observedAt - richRequestAt >= admissionDelayMs)
            ) {
              throw new Error("Native hold expired before admission assertions; setup invalid");
            }
            await page.screenshot({ path: path.join(output, `head-${values.admission}.png`) });
          }
          if (values.admission === "fail") {
            const reload = page.getByRole("button", { name: "Reload", exact: true });
            await reload.waitFor({ state: "visible" });
            if (
              !(await reload.evaluate((element) => {
                const rect = element.getBoundingClientRect();
                return element.contains(
                  document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
                );
              }))
            ) {
              throw new Error("Rich import recovery is not hit-testable");
            }
            await page.screenshot({ path: path.join(output, "head-failed-rich-import.png") });
          } else {
            await page.waitForFunction(
              () => Boolean(Reflect.get(window, "__richRiskReadiness").arrivalMs),
              undefined,
              { timeout: 30000 },
            );
            if (values.admission) {
              await page
                .locator("section.chat .chat-text")
                .filter({ hasText: latestText })
                .waitFor();
            }
          }
        }
        const after =
          fixture === "first-rich-arrival"
            ? (await cdp.send("Performance.getMetrics")).metrics
            : bootAfter;
        const coverage = captureCoverage ? await page.coverage.stopJSCoverage() : undefined;
        if (
          variant === "head" &&
          (fixture === "mixed-history" || fixture === "initial-rich") &&
          coverage?.some((entry) => new URL(entry.url, baseUrl).pathname === `/${richAsset}`)
        ) {
          throw new Error("Image-only history evaluated the optional rich family");
        }
        if (
          variant === "head" &&
          fixture === "first-rich-arrival" &&
          values.admission !== "fail" &&
          coverage &&
          !coverage.some((entry) => new URL(entry.url, baseUrl).pathname === `/${richAsset}`)
        ) {
          throw new Error("The first rich tool did not evaluate the candidate rich family");
        }
        if (coverage) {
          await writeFile(
            path.join(output, `${pair}-${variant}.coverage.json`),
            JSON.stringify({ coverage, bootCoverage, preArrivalCoverage }, null, 2),
          );
        }
        workerNetwork?.assertHealthy();
        const data = await page.evaluate(() => ({
          readiness: Reflect.get(window, "__richRiskReadiness"),
          capturedAtMs: performance.now(),
          longTasks: Reflect.get(window, "__richRiskLongTasks"),
          layoutShifts: Reflect.get(window, "__richRiskLayoutShifts"),
          navigation: performance.getEntriesByType("navigation").map((entry) => entry.toJSON()),
          resources: performance.getEntriesByType("resource").map((entry) => ({
            name: entry.name,
            startTime: entry.startTime,
            duration: entry.duration,
            fetchStart: Reflect.get(entry, "fetchStart"),
            domainLookupStart: Reflect.get(entry, "domainLookupStart"),
            domainLookupEnd: Reflect.get(entry, "domainLookupEnd"),
            connectStart: Reflect.get(entry, "connectStart"),
            connectEnd: Reflect.get(entry, "connectEnd"),
            requestStart: Reflect.get(entry, "requestStart"),
            responseStart: Reflect.get(entry, "responseStart"),
            responseEnd: Reflect.get(entry, "responseEnd"),
            nextHopProtocol: Reflect.get(entry, "nextHopProtocol"),
            encodedBodySize: Reflect.get(entry, "encodedBodySize"),
            decodedBodySize: Reflect.get(entry, "decodedBodySize"),
            transferSize: Reflect.get(entry, "transferSize"),
            initiatorType: Reflect.get(entry, "initiatorType"),
          })),
        }));
        const cpu = richBootCpuDelta(before, bootAfter);
        const arrivalCpu = arrivalBefore ? richBootCpuDelta(arrivalBefore, after) : undefined;
        const totalCpu = richBootCpuDelta(before, after);
        const cutoffMs = data.readiness.arrivalMs ?? data.readiness.readyMs;
        const navigationStart = bootAfter.find(
          (metric) => metric.name === "NavigationStart",
        )!.value;
        const networkClock = qualifyRouteNetworkClock(
          networkRequests,
          navigationStart,
          data.resources.map((resource) => ({ ...resource, url: resource.name })),
        );
        if (!networkClock.passed) {
          throw new Error("Rich boot network clocks do not match");
        }
        const resources = await summarizeRichBootResources(
          bundleInfo,
          data.resources,
          cutoffMs,
          coverage,
          networkRequests,
          navigationStart,
        );
        const coverageSummary = coverage
          ?.filter((entry) => new URL(entry.url, baseUrl).pathname.startsWith("/assets/"))
          .map((entry) => Object.assign({ url: entry.url }, summarizeScriptCoverage(entry)));
        const documentPath = new URL(controlUiSessionUrl(baseUrl, sessionKey)).pathname;
        const documentRequests = server.requests.filter((request) => request.url === documentPath);
        if (documentRequests.length !== 1) {
          throw new Error(`Expected one document request, received ${documentRequests.length}`);
        }
        results.push({
          pair,
          position,
          variant,
          fixture,
          measurementKind: values.admission ? "admission" : values.coverage ? "coverage" : "timing",
          buildId,
          bundle: bundleInfo,
          hostLoad,
          ...data,
          responses,
          networkRequests,
          networkClock,
          earlyHints,
          requests: [...server.requests],
          workerRequests: workerNetwork?.snapshot().requests.slice(workerRequestStart),
          workerSetup,
          cpu,
          arrivalCpu,
          totalCpu,
          arrivalLatencyMs:
            data.readiness.arrivalMs && data.readiness.arrivalStartedMs
              ? data.readiness.arrivalMs - data.readiness.arrivalStartedMs
              : undefined,
          admissionReceipt,
          coverageSummary,
          cutoffMs,
          ...resources,
          errors,
        });
        await writeFile(
          path.join(output, "summary.json"),
          JSON.stringify(
            {
              workload: fixture,
              fixtureNow: now,
              counterbalance: values.counterbalance,
              coverage: values.coverage,
              admission: values.admission,
              runner,
              browser: {
                version: browser.version(),
                executable: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
              },
              richFamily,
              limitations: [
                "Synthetic Gateway, not provider latency",
                "bundleResources reports on-disk raw/gzip sizes, not bytes delivered; HTTP encodedBodySize is transport-encoded bytes",
                "V8 coverage is evaluated-source range coverage, not compiled bytes",
                "First-rich arrival includes image decode and visible tool summary, not tool-only latency",
                "Admission fixed-delay response has no manual release",
                "Saved offset, old-row reveal and MCP retirement are separate proofs",
              ],
              base,
              head,
              pairs,
              networkLatencyMs,
              serviceWorker: values["service-worker"],
              http2: values.http2,
              compareHttp2: values["compare-http2"],
              compareDeliveryHints: values["compare-delivery-hints"],
              typefaceProfile: values["typeface-profile"],
              results,
            },
            null,
            2,
          ),
        );
        if (pair === 0) {
          await page.screenshot({ path: path.join(output, `${variant}.png`) });
        }
        if (values.admission === "fail" && recoveryMessage) {
          const row = await gateway.getSessionRow(sessionKey);
          const recoveredHistory = {
            sessionId: row.sessionId,
            sessionInfo: { ...row, status: "idle", activeRunIds: [], hasActiveRun: false },
            messages: [...scenario.historyMessages, recoveryMessage],
            inFlightRun: null,
          };
          await gateway.setMethodResponse("chat.history", recoveredHistory);
          await gateway.setMethodResponse("chat.startup", recoveredHistory);
          server.setFixtureReader((pathname) =>
            pathname === "/__rich-proof.png"
              ? { body: RICH_BOOT_IMAGE, contentType: "image/png" }
              : pathname.endsWith(CONTROL_UI_BOOTSTRAP_CONFIG_PATH)
                ? {
                    body: JSON.stringify(createControlUiMockBootstrapConfig(scenario)),
                    contentType: "application/json",
                  }
                : undefined,
          );
          await Promise.all([
            page.waitForEvent("domcontentloaded"),
            page.getByRole("button", { name: "Reload", exact: true }).click(),
          ]);
          await page.locator("section.chat .chat-text").filter({ hasText: latestText }).waitFor();
          await page.waitForFunction(() =>
            [...document.querySelectorAll<HTMLImageElement>("section.chat img")].some((image) => {
              const bounds = image.getBoundingClientRect();
              return (
                image.src.endsWith("/__rich-proof.png") &&
                image.complete &&
                image.naturalWidth > 0 &&
                bounds.width > 0 &&
                bounds.height > 0 &&
                bounds.bottom > 0 &&
                bounds.top < window.innerHeight &&
                getComputedStyle(image).visibility === "visible"
              );
            }),
          );
          if (await page.locator(".chat-transcript-preparation").count()) {
            throw new Error("Reload retained the failed rich preparation");
          }
          const documentCount = server.requests.filter(
            (request) =>
              request.method === "GET" && new URL(request.url, baseUrl).pathname === documentPath,
          ).length;
          if (documentCount !== 2 || page.url() !== controlUiSessionUrl(baseUrl, sessionKey)) {
            throw new Error("Recovery did not reload the same session exactly once");
          }
          await page.screenshot({ path: path.join(output, "head-recovered.png") });
          await writeFile(
            path.join(output, "recovery.json"),
            JSON.stringify({ documentCount, url: page.url(), recovered: true }),
          );
        }
        console.log(
          JSON.stringify({ pair, variant, hostLoad, readiness: data.readiness, cpu, errors }),
        );
        if (errors.length) {
          throw new Error(errors.join("\n"));
        }
      } catch (error) {
        await page.screenshot({ path: path.join(output, `${variant}-${pair}-failure.png`) });
        await writeFile(
          path.join(output, `${variant}-${pair}-failure.json`),
          JSON.stringify(
            {
              error: error instanceof Error ? error.message : String(error),
              errors,
              runner,
              bundle: bundleInfo,
              requests: [...server.requests],
              browser: await page.evaluate(() => ({
                readiness: Reflect.get(window, "__richRiskReadiness"),
                text: document.querySelector("section.chat")?.textContent,
              })),
            },
            null,
            2,
          ),
        );
        throw error;
      } finally {
        await context.close();
      }
    }
  }
} finally {
  try {
    try {
      await workerNetwork?.close();
    } finally {
      await browser?.close();
    }
  } finally {
    await proxy?.close();
    await server.close();
  }
}
