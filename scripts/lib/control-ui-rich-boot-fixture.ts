import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { parse } from "acorn";
import { projectAgentToolActivity } from "../../src/infra/agent-activity-events.ts";
import { encodePngRgb } from "../../src/media/png-encode.ts";
import { extractControlUiStartupAssetPaths } from "../../ui/config/control-ui-startup-assets.ts";
import { normalizeControlUiBuildInfo } from "../../ui/src/build-info-normalizers.ts";
import type { MockGatewayControls } from "../../ui/src/test-helpers/control-ui-e2e-contract.ts";
import { createTeamScaleHistoryFixture } from "../../ui/src/test-helpers/control-ui-team-scale-history-fixture.ts";
import { summarizeJavaScriptResources } from "./control-ui-cold-load-trace.ts";
import { routeNetworkPhase, type RouteNetworkObservation } from "./control-ui-route-network.ts";

export const RICH_BOOT_IMAGE = encodePngRgb(Buffer.alloc(32 * 32 * 3, 160), 32, 32);

const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** Preflight outside measurement: identify the actual emitted family and its static closure. */
export async function inspectRichBootBundles(
  base: string,
  head: string,
  requireRichFamily: boolean,
) {
  const bundles = await Promise.all(
    [base, head].map(async (directory) => {
      const html = await readFile(path.join(directory, "index.html"), "utf8");
      const embedded = /globalThis\.OPENCLAW_CONTROL_UI_BUILD_INFO=(\{.*?\});<\/script>/su.exec(
        html,
      )?.[1];
      if (!embedded) {
        throw new Error(`Missing embedded build identity: ${directory}`);
      }
      return {
        directory,
        indexSha256: sha(html),
        build: normalizeControlUiBuildInfo(JSON.parse(embedded)),
        startupAssets: extractControlUiStartupAssetPaths(html),
      };
    }),
  );
  // Legacy timing callers need bundle identity, not the newer deferred-family layout.
  if (!requireRichFamily) {
    return { bundles, richFamily: undefined };
  }
  // Source maps identify the candidate family; imports come from parsed emitted JS, not filenames.
  const owners = ["chat-rich-presentation.runtime.ts", "chat-message-bubble-tools.tsx"];
  let richSource: string | undefined;
  let richAsset: string | undefined;
  for (const owner of owners) {
    const matches: string[] = [];
    for (const name of await readdir(path.join(head, "assets"))) {
      if (!name.endsWith(".js.map")) {
        continue;
      }
      const map = JSON.parse(await readFile(path.join(head, "assets", name), "utf8"));
      if (map.sources.some((source: string) => source.endsWith(`/components/${owner}`))) {
        matches.push(`assets/${name.slice(0, -4)}`);
      }
    }
    if (matches.length > 1) {
      throw new Error(`Ambiguous rich source owner ${owner}: ${matches.join(", ")}`);
    }
    if (matches.length === 1) {
      richAsset = matches[0];
      richSource = owner;
      break;
    }
  }
  if (!richAsset) {
    throw new Error(
      "This proof mode requires a candidate rich implementation in emitted source maps",
    );
  }
  const richClosure = new Map<string, { sha256: string; imports: string[] }>();
  async function inspectStaticClosure(file: string): Promise<void> {
    if (richClosure.has(file)) {
      return;
    }
    const code = await readFile(path.join(head, file), "utf8");
    const imports = parse(code, { ecmaVersion: "latest", sourceType: "module" }).body.flatMap(
      (node) =>
        (node.type === "ImportDeclaration" ||
          node.type === "ExportNamedDeclaration" ||
          node.type === "ExportAllDeclaration") &&
        node.source &&
        typeof node.source.value === "string"
          ? [path.posix.normalize(path.posix.join(path.posix.dirname(file), node.source.value))]
          : [],
    );
    richClosure.set(file, { sha256: sha(code), imports });
    for (const dependency of imports) {
      await inspectStaticClosure(dependency);
    }
  }
  await inspectStaticClosure(richAsset);
  return {
    bundles,
    richFamily: {
      asset: richAsset,
      source: richSource,
      staticClosure: Object.fromEntries(richClosure),
    },
  };
}

// Serialized into the document by both source and compiled runners; no module captures.
export const installRichBootReadiness = ({
  bootstrap,
  attribute,
  finalText: completedText,
  activeText: runningText,
  fixture: fixtureKind,
}: {
  bootstrap: string;
  attribute: string;
  finalText: string;
  activeText: string;
  fixture: string;
}) => {
  const apply = () => {
    if (!document.documentElement) {
      return false;
    }
    document.documentElement.setAttribute(attribute, bootstrap);
    return true;
  };
  if (!apply()) {
    const observer = new MutationObserver(() => {
      if (apply()) {
        observer.disconnect();
      }
    });
    observer.observe(document, { childList: true });
  }
  const timings: Record<string, number> = {};
  Object.assign(window, { __richRiskReadiness: timings });
  timings.layoutShift = 0;
  const longTasks: Array<{ start: number; duration: number }> = [];
  Object.assign(window, { __richRiskLongTasks: longTasks });
  const layoutShifts: unknown[] = [];
  Object.assign(window, { __richRiskLayoutShifts: layoutShifts });
  new PerformanceObserver((entries) => {
    for (const entry of entries.getEntries()) {
      longTasks.push({ start: entry.startTime, duration: entry.duration });
    }
  }).observe({ type: "longtask", buffered: true });
  new PerformanceObserver((entries) => {
    for (const entry of entries.getEntries()) {
      if (!Reflect.get(entry, "hadRecentInput")) {
        timings.layoutShift += Reflect.get(entry, "value");
        const sources = Reflect.get(entry, "sources") as Array<{
          node?: Node;
          previousRect: DOMRectReadOnly;
          currentRect: DOMRectReadOnly;
        }>;
        layoutShifts.push({
          startTime: entry.startTime,
          value: Reflect.get(entry, "value"),
          sources: sources.map(({ node, previousRect, currentRect }) => ({
            node: node instanceof Element ? `${node.tagName}.${node.className}` : node?.nodeName,
            previousRect: previousRect.toJSON(),
            currentRect: currentRect.toJSON(),
          })),
        });
      }
    }
  }).observe({ type: "layout-shift", buffered: true });
  const visible = (node: Element) => {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.top < innerHeight &&
      style.visibility !== "hidden" &&
      style.display !== "none"
    );
  };
  const check = () => {
    const composer = document.querySelector<HTMLTextAreaElement>(
      ".agent-chat__composer-combobox textarea",
    );
    if (!timings.composerMs && composer && !composer.disabled && visible(composer)) {
      timings.composerMs = performance.now();
    }
    for (const bubble of document.querySelectorAll("section.chat .chat-text")) {
      if (!visible(bubble)) {
        continue;
      }
      if (!timings.finalMs && bubble.textContent?.includes(completedText)) {
        timings.finalMs = performance.now();
      }
      if (!timings.activeMs && bubble.textContent?.includes(runningText)) {
        timings.activeMs = performance.now();
      }
    }
    const summary = [
      ...document.querySelectorAll(
        "section.chat .chat-work-group, section.chat .chat-tool-msg-summary, section.chat .chat-activity-group__summary",
      ),
    ].find(visible);
    const image = [
      ...document.querySelectorAll<HTMLImageElement>("section.chat img.chat-message-image"),
    ].find((node) => visible(node) && node.complete && node.naturalWidth > 0);
    const rich =
      fixtureKind === "initial-rich" || fixtureKind === "first-rich-arrival" ? image : summary;
    if (!timings.richMs && rich) {
      timings.richMs = performance.now();
    }
    const ready =
      timings.composerMs &&
      timings.finalMs &&
      ((fixtureKind !== "rich-history" && fixtureKind !== "initial-rich") ||
        (timings.activeMs && timings.richMs));
    if (!timings.readyMs && ready) {
      timings.readyMs = performance.now();
    }
    if (timings.arrivalStartedMs && !timings.arrivalMs && rich && summary) {
      timings.arrivalMs = performance.now();
    }
    if (!timings.readyMs || (fixtureKind === "first-rich-arrival" && !timings.arrivalMs)) {
      requestAnimationFrame(check);
    }
  };
  requestAnimationFrame(check);
};

export function createRichBootHistory(
  fixture: string,
  now: number,
  sessionKey: string,
  finalText: string,
) {
  const richHistory = [
    { role: "user", content: "Inspect the synthetic layout.", timestamp: now - 5000 },
    {
      role: "assistant",
      content: "I will inspect the layout first.",
      phase: "commentary",
      runId: "completed-risk",
      timestamp: now - 4000,
    },
    {
      role: "toolResult",
      toolName: "read",
      toolCallId: "read-layout",
      content: "Synthetic layout inspection complete.",
      runId: "completed-risk",
      timestamp: now - 3000,
    },
    {
      role: "assistant",
      content: finalText,
      phase: "final_answer",
      runId: "completed-risk",
      timestamp: now - 2000,
    },
    { role: "user", content: "Continue with the next synthetic check.", timestamp: now - 1000 },
  ];
  const plainHistory =
    fixture === "rich-history" || fixture === "initial-rich"
      ? []
      : createTeamScaleHistoryFixture({
          now,
          messageCount: fixture === "mixed-history" ? 240 : 60,
          inlineWidgets: 0,
          sessionInfo: { key: sessionKey },
          models: [],
          assets: new Map(),
        }).historyMessages.map((message, index) => ({
          role: message.role,
          timestamp: message.timestamp,
          __openclaw: message["__openclaw"],
          content:
            index === (fixture === "mixed-history" ? 239 : 59)
              ? finalText
              : message.content
                  .flatMap((part) =>
                    "text" in part && typeof part.text === "string"
                      ? [part.text.replace(/\[embed[^\]]*\/\]/gu, "")]
                      : [],
                  )
                  .join("\n"),
        }));
  const historyMessages: unknown[] =
    fixture === "rich-history" || fixture === "initial-rich" ? richHistory : plainHistory;
  if (fixture === "mixed-history") {
    historyMessages[1] = {
      ...plainHistory[1],
      content: "Old synthetic image.\nMEDIA:https://example.com/proof.png",
    };
    historyMessages[3] = {
      ...plainHistory[3],
      role: "toolResult",
      toolName: "read",
      toolCallId: "old-rich-read",
      content: "Old synthetic tool output.",
      runId: "old-rich-run",
    };
  }
  return { historyMessages, oldMedia: plainHistory[1] };
}

/** Same tool start/result and settled-message envelope as heavy-terminal-arrival. */
export async function emitRichBootToolResult(
  gateway: MockGatewayControls,
  options: {
    sessionKey: string;
    runId: string;
    now: number;
    messageSeq: number;
    text: string;
    includeActivity: boolean;
    imageUrl: string;
  },
) {
  const { sessionKey, runId, now, messageSeq, text, includeActivity, imageUrl } = options;
  const args = { path: "synthetic-first-rich.txt" };
  if (includeActivity) {
    await gateway.emitGatewayEvent("agent", {
      sessionKey,
      runId,
      seq: 1,
      stream: "item",
      ts: now + 1,
      data: projectAgentToolActivity({
        phase: "start",
        toolCallId: "first-rich",
        name: "read",
        args,
      }),
    });
    await gateway.emitGatewayEvent("agent", {
      sessionKey,
      runId,
      seq: 2,
      stream: "item",
      ts: now + 2,
      data: projectAgentToolActivity({
        phase: "result",
        toolCallId: "first-rich",
        name: "read",
        args,
        result: { content: [{ type: "text", text: "Synthetic rich output." }] },
      }),
    });
  }
  const message = {
    role: "assistant",
    timestamp: now + 3,
    content: [
      { type: "text", text },
      { type: "image", url: imageUrl, alt: "Synthetic rich arrival", width: 32, height: 32 },
      { type: "toolCall", id: "first-rich", name: "read", arguments: args },
      { type: "toolResult", id: "first-rich", name: "read", text: "Synthetic rich output." },
    ],
    __openclaw: { id: "first-rich-result", seq: messageSeq, runId, runTerminal: true },
  };
  await gateway.emitGatewayEvent("session.message", {
    sessionKey,
    runId,
    message,
    messageId: "first-rich-result",
    messageSeq,
  });
  await gateway.emitGatewayEvent("chat", { sessionKey, runId, state: "final", message });
  return message;
}

export async function readRichBootRunnerIdentity(runnerPath: string, providedManifest?: string) {
  const manifestPath =
    providedManifest ??
    (runnerPath.endsWith(".ts")
      ? undefined
      : path.join(path.dirname(runnerPath), "benchmark-harness-fingerprint.json"));
  const manifest = manifestPath ? await readFile(path.resolve(manifestPath)) : undefined;
  const fingerprint = manifest ? JSON.parse(manifest.toString()) : undefined;
  const entrySha256 = sha(await readFile(runnerPath));
  const sourceMode = runnerPath.endsWith(".ts");
  const sourceDirectory = sourceMode ? path.dirname(runnerPath) : fingerprint?.checkout;
  const sourceIdentity = sourceDirectory
    ? {
        head: execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: sourceDirectory,
          encoding: "utf8",
        }).trim(),
        tree: execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
          cwd: sourceDirectory,
          encoding: "utf8",
        }).trim(),
        status: execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
          cwd: sourceDirectory,
          encoding: "utf8",
        }).trim(),
      }
    : undefined;
  if (sourceIdentity?.status) {
    throw new Error("Commit harness sources before benchmarking");
  }
  if (
    fingerprint &&
    (sourceIdentity?.head !== fingerprint.source.head ||
      sourceIdentity?.tree !== fingerprint.source.tree)
  ) {
    throw new Error("Harness source tree does not match its common manifest");
  }
  if (
    fingerprint &&
    (runnerPath.endsWith(".ts")
      ? fingerprint.sources[path.relative(fingerprint.checkout, runnerPath)]
      : fingerprint.outputFiles[path.basename(runnerPath)]) !== entrySha256
  ) {
    throw new Error("Runner does not match its common harness manifest");
  }
  const runner = {
    path: runnerPath,
    sha256: entrySha256,
    mode: runnerPath.endsWith(".ts") ? "source" : "compiled",
    node: process.version,
    sourceHead: sourceIdentity?.head,
    sourceIdentity,
    manifestPath,
    manifestSha256: manifest ? sha(manifest) : undefined,
  };
  return runner;
}

export function richBootCpuDelta(
  start: readonly { name: string; value: number }[],
  end: readonly { name: string; value: number }[],
) {
  return Object.fromEntries(
    ["TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration"].map((key) => [
      key,
      1000 *
        (end.find((metric) => metric.name === key)!.value -
          start.find((metric) => metric.name === key)!.value),
    ]),
  );
}

export async function summarizeRichBootResources(
  bundleInfo: { directory: string; startupAssets: string[] },
  resources: readonly {
    name: string;
    startTime: number;
    responseEnd: number;
    decodedBodySize: number;
    encodedBodySize: number;
    transferSize: number;
  }[],
  cutoffMs: number,
  coverage: Parameters<typeof summarizeJavaScriptResources>[1],
  networkRequests: RouteNetworkObservation[],
  navigationStart: number,
) {
  const network = routeNetworkPhase(networkRequests, navigationStart, 0, cutoffMs);
  const startupRequests = [...network.js.started, ...network.css.started].filter((request) =>
    bundleInfo.startupAssets.includes(new URL(request.url).pathname.slice(1)),
  );
  const bundleResources = [];
  for (const resource of resources) {
    const asset = new URL(resource.name).pathname.slice(1);
    if (!asset.startsWith("assets/") || !/\.(?:js|css)$/u.test(asset)) {
      continue;
    }
    const bytes = await readFile(path.join(bundleInfo.directory, asset));
    bundleResources.push({
      asset,
      rawBytes: bytes.byteLength,
      gzipBytes: gzipSync(bytes).byteLength,
      startup: bundleInfo.startupAssets.includes(asset),
      completedByCutoff: resource.responseEnd > 0 && resource.responseEnd <= cutoffMs,
    });
  }
  const entries = resources
    .filter((entry) => entry.responseEnd > 0)
    .map((entry) => ({
      url: entry.name,
      decodedBytes: entry.decodedBodySize,
      encodedBytes: entry.encodedBodySize,
      transferBytes: entry.transferSize,
    }));
  const completed = new Set(
    resources.filter((entry) => entry.responseEnd <= cutoffMs).map((entry) => entry.name),
  );
  return {
    bundleResources,
    javaScriptResources: summarizeJavaScriptResources(entries, coverage),
    javaScriptResourcesAtCutoff: summarizeJavaScriptResources(
      entries.filter((entry) => completed.has(entry.url)),
    ),
    assetRequestsAtCutoff: {
      javascript: network.js.started.length,
      css: network.css.started.length,
      startupJavascript: startupRequests.filter((entry) =>
        new URL(entry.url).pathname.endsWith(".js"),
      ).length,
      startupCss: startupRequests.filter((entry) => new URL(entry.url).pathname.endsWith(".css"))
        .length,
    },
    networkAtCutoff: network,
  };
}
