import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

if (
  process.platform !== "darwin" ||
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.RUNNER_ENVIRONMENT !== "github-hosted" ||
  !process.env.RUNNER_TEMP
) {
  throw new Error("This diagnostic requires disposable hosted macOS.");
}

const started = performance.now();
const root = fileURLToPath(new URL("../", import.meta.url));
const groups = [
  ["snapshot-derived-data", [path.join(root, "apps/ios/build/SnapshotDerivedData")]],
  ["checkout-git", [path.join(root, ".git")]],
  ["checkout-dependencies", [path.join(root, "node_modules")]],
  ["checkout-artifacts", [path.join(root, ".artifacts")]],
  ["checkout-ios-build", [path.join(root, "apps/ios/build")]],
  ["checkout-apps", [path.join(root, "apps")]],
  ["checkout-packages", [path.join(root, "packages")]],
  ["checkout-scripts", [path.join(root, "scripts")]],
  ["checkout-docs", [path.join(root, "docs")]],
  ["checkout-src", [path.join(root, "src")]],
  ["checkout-extensions", [path.join(root, "extensions")]],
  ["checkout-test", [path.join(root, "test")]],
  ["checkout-ui", [path.join(root, "ui")]],
  ["checkout-config", [path.join(root, "config")]],
  ["checkout-github", [path.join(root, ".github")]],
  ["checkout-agents", [path.join(root, ".agents")]],
  ["checkout-root", [root.replace(/\/$/u, "")]],
  ["checkout-other", [root.replace(/\/$/u, "")]],
  [
    "simulator",
    [
      "/Library/Developer/CoreSimulator",
      path.join(os.homedir(), "Library/Developer/CoreSimulator"),
    ],
  ],
  ["xcode-user", [path.join(os.homedir(), "Library/Developer/Xcode")]],
  ["caches", [path.join(os.homedir(), "Library/Caches"), path.join(os.homedir(), ".cargo")]],
  [
    "spotlight-store",
    ["/.Spotlight-V100", path.join(os.homedir(), "Library/Metadata/CoreSpotlight")],
  ],
  ["system", ["/System", "/usr", "/Library"]],
].map(([name, paths]) => [
  name,
  paths.map((prefix) => {
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const boundary = name === "checkout-root" ? "/?(?:\\s|$)" : "(?:/|\\s|$)";
    return new RegExp(`(?:^|\\s)${escaped}${boundary}`, "u");
  }),
]);
// Fixed classes only: never retain native call names or pathname text.
const operationGroups = [
  ["enumeration", /^(?:getdirentries(?:64|attr)?|getattrlistbulk|searchfs)$/u],
  [
    "metadata",
    /^(?:(?:f|l)?stat(?:64)?(?:_extended)?|fstatat(?:64)?|(?:f)?getattrlist(?:at)?|(?:f)?(?:get|list)xattr|access(?:_extended)?|(?:f)?pathconf|fsgetpath|readlink(?:at)?)$/u,
  ],
  ["open", /^(?:open(?:at|_extended|_dprotected)?(?:_nocancel)?|guarded_open.*)$/u],
  ["read", /^(?:(?:p)?readv?(?:_nocancel)?|aio_read|RdData.*)$/u],
  ["write", /^(?:(?:p)?writev?(?:_nocancel)?|guarded_(?:p)?writev?_np|aio_write|WrData.*)$/u],
  ["close", /^(?:close(?:_nocancel)?|guarded_close_np)$/u],
  ["paging", /^(?:PAGE_IN(?:_FILE|_ANON)?|PgIn.*|PgOut.*)$/u],
];
const counts = Object.fromEntries([
  ...groups.map(([name]) => [name, 0]),
  ["other-path", 0],
  ["no-path", 0],
]);
const operationsByPath = Object.fromEntries(
  Object.keys(counts).map((name) => [
    name,
    Object.fromEntries([...operationGroups.map(([operation]) => [operation, 0]), ["other", 0]]),
  ]),
);
let lines = 0;
let oversizedLines = 0;
let droppedNotices = 0;
let tail = "";
let discarding = false;

function observe(line) {
  if (/dropped/iu.test(line)) {
    droppedNotices++;
  }
  if (!/\s(?:mds|mds_stores|mdworker|mdworker_shared)\.\d+\s*$/u.test(line)) {
    return;
  }
  lines++;
  const normalized = line.replace(/(^|\s)\/System\/Volumes\/Data(?=\/)/gu, "$1");
  const group = groups.find(([, paths]) => paths.some((pattern) => pattern.test(normalized)));
  const category = group?.[0] ?? (/\s\//u.test(line) ? "other-path" : "no-path");
  counts[category]++;
  // Apple's wide display puts the call immediately after the timestamp.
  const call = /^\s*\d{2}:\d{2}:\d{2}(?:\.\d+)?\s+(\S+)/u.exec(line)?.[1] ?? "";
  const operation = operationGroups.find(([, pattern]) => pattern.test(call))?.[0] ?? "other";
  operationsByPath[category][operation]++;
}

const child = spawn(
  "/usr/bin/sudo",
  [
    "-n",
    "/usr/bin/fs_usage",
    "-w",
    "-F",
    "-f",
    "filesys",
    "-t",
    "45",
    "mds",
    "mds_stores",
    "mdworker",
    "mdworker_shared",
  ],
  { stdio: ["ignore", "pipe", "ignore"] },
);
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  const parts = (tail + chunk).split("\n");
  tail = parts.pop();
  for (const line of parts) {
    if (!discarding) {
      observe(line);
    }
    discarding = false;
  }
  if (tail.length > 65_536) {
    oversizedLines++;
    tail = "";
    discarding = true;
  }
});
const exitCode = await new Promise((resolve) => {
  child.on("error", () => resolve(null));
  child.on("close", (code) => resolve(code));
});
const elapsedMs = Math.round(performance.now() - started);
await writeFile(
  path.join(process.env.RUNNER_TEMP, "ios-spotlight-path-probe.json"),
  `${JSON.stringify(
    {
      status: exitCode === 0 && lines > 0 ? "observed" : "unavailable",
      elapsedMs,
      exitCode,
      lines,
      oversizedLines,
      droppedNotices,
      counts,
      operationsByPath,
      limits: [
        "filesystem-events-from-four-named-host-spotlight-processes-only",
        "event-counts-are-not-cpu-time-or-indexed-document-counts",
        "paths-absent-or-truncated-by-fs-usage-cannot-be-attributed",
        "checkout-root-is-the-displayed-path-not-proof-against-native-truncation",
        "no-raw-paths-or-native-stderr-retained",
      ],
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);
// Preserve the existing 60-second host-idle observation window.
await delay(Math.max(0, 60_000 - (performance.now() - started)));
