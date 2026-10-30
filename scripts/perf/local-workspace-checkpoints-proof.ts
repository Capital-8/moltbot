/**
 * Native btrfs owner and SIGKILL recovery proof; synthetic state only, no Gateway.
 * On an isolated Linux btrfs host with btrfs-progs and Git installed:
 * node --import ./scripts/tsx.mjs scripts/perf/local-workspace-checkpoints-proof.ts
 *   --output /btrfs/new-proof-directory
 *
 * Exercises the real projection owner, manifest worker, SQLite writer and lease.
 * Proof-only store wrappers pause after snapshot creation or after retirement of
 * the old snapshot, before the production owner commits checkpoint acceptance.
 * A separate process kills that owner, changes the source again, then restarts it.
 * The fixture subvolume is removed even on failure; logs/report remain in output.
 * Requires permission to create/delete subvolumes and btrfs send checkpoints.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { LocalWorkspaceManifestAction } from "../../src/gateway/worker-environments/local-workspace-manifest-scan.js";
import type { LocalWorkspaceStore } from "../../src/gateway/worker-environments/local-workspace-store.js";
import type { LocalWorkspaceOwner } from "../../src/gateway/worker-environments/local-workspace-types.js";
import { BASE_GATEWAY_BENCH_CONFIG, createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    child: { type: "string" },
    direction: { type: "string" },
    point: { type: "string" },
  },
});
assert(values.output, "--output must name a new directory on btrfs");
assert.equal(process.platform, "linux", "Native btrfs proof requires Linux");
const output = path.resolve(values.output);
const fixture = path.join(output, "fixture");
const canonical = path.join(fixture, "canonical");
const repository = path.join(fixture, "repository");
const worktreeId = "00000000-0000-4000-8000-000000001902";
const stateRoot = path.join(fixture, "state");
const projection = path.join(stateRoot, "worktree-projections", worktreeId, "workspace");
const checkpoints = path.join(path.dirname(projection), "checkpoints");
type Direction = "canonical" | "projection";
type CrashPoint = "before-scan" | "after-retirement";
type Receipt = {
  pending?: { target: Direction; token: string };
  accepted: Partial<Record<Direction, { token: string }>>;
};
const btrfs = (...args: string[]) => execFileSync("btrfs", args, { encoding: "utf8" });
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });
const read = (root: string) => fs.readFileSync(path.join(root, "source.txt"), "utf8");
function edit(root: string, bytes: string) {
  const file = path.join(root, "source.txt");
  const before = fs.statSync(file, { bigint: true });
  assert.equal(BigInt(Buffer.byteLength(bytes)), before.size);
  fs.writeFileSync(file, bytes);
  // Date/utimes round nanoseconds; GNU touch preserves the exact native mtime.
  const seconds = before.mtimeNs / 1_000_000_000n;
  const nanos = String(before.mtimeNs % 1_000_000_000n).padStart(9, "0");
  execFileSync("touch", ["-m", "-d", `@${seconds}.${nanos}`, "--", file]);
  const after = fs.statSync(file, { bigint: true });
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeNs, before.mtimeNs);
  return {
    sizeBefore: before.size.toString(),
    sizeAfter: after.size.toString(),
    mtimeNsBefore: before.mtimeNs.toString(),
    mtimeNsAfter: after.mtimeNs.toString(),
  };
}
function editWithinGeneration(root: string, bytes: string) {
  // Prime the current transaction without changing content. Generation is a
  // transaction fact, so a second write can change bytes without advancing it.
  edit(root, read(root));
  const generation = () => {
    const match = /^\s*Generation:\s*(\d+)\s*$/mu.exec(btrfs("subvolume", "show", root));
    assert(match, "btrfs must report the source subvolume generation");
    return match[1];
  };
  const generationBefore = generation();
  const metadata = edit(root, bytes);
  const generationAfter = generation();
  assert.equal(generationAfter, generationBefore, "Exercise a write inside one btrfs generation");
  return { generationBefore, generationAfter, ...metadata };
}
function receipt(raw: string | null): Receipt {
  assert(raw, "Expected durable native checkpoint state");
  return JSON.parse(raw) as Receipt;
}
function checkpointFromDisk() {
  const db = new DatabaseSync(path.join(stateRoot, "state", "openclaw.sqlite"), { readOnly: true });
  try {
    const row = db
      .prepare(
        "SELECT filesystem_checkpoints_json FROM local_workspace_projections WHERE worktree_id = ?",
      )
      .get(worktreeId);
    const raw = row?.filesystem_checkpoints_json;
    assert(typeof raw === "string", "Expected durable checkpoint receipt");
    return receipt(raw);
  } finally {
    db.close();
  }
}

async function child() {
  process.env = createGatewayBenchEnv(
    path.join(fixture, "home"),
    path.join(fixture, "openclaw.json"),
    {
      startupTrace: false,
      caseEnv: { OPENCLAW_STATE_DIR: stateRoot, TMPDIR: path.join(fixture, "tmp") },
    },
  );
  const { withLocalWorkspaceProjection } =
    await import("../../src/gateway/worker-environments/local-workspace-projection.js");
  const { projectionOperations } =
    await import("../../src/gateway/worker-environments/local-workspace-state.js");
  const { withLocalWorkspaceStore } =
    await import("../../src/gateway/worker-environments/local-workspace-store.js");
  const state = await import("../../src/state/openclaw-state-db.js");
  (await import("../../src/config/runtime-snapshot.js")).setRuntimeConfigSnapshot(
    BASE_GATEWAY_BENCH_CONFIG,
  );
  state.openOpenClawStateDatabase();
  const sessionKey = "agent:main:workspace:checkpoint-proof";
  const owner: LocalWorkspaceOwner = {
    agentId: "main",
    sessionKey,
    sessionId: "checkpoint-proof",
    lifecycleRevision: null,
    env: process.env,
    assertCurrent() {},
    worktree: {
      id: worktreeId,
      name: "checkpoint-proof",
      repoFingerprint: "synthetic",
      repoRoot: repository,
      path: canonical,
      branch: "openclaw/proof",
      baseRef: "main",
      ownerKind: "session",
      ownerId: sessionKey,
      createdAt: 1,
      lastActiveAt: 1,
    },
  };
  let synchronization = 0;
  const synchronize = (target: Direction) =>
    withLocalWorkspaceProjection(owner, async (operations) => {
      const phase = { synchronization: ++synchronization, target };
      console.log(JSON.stringify(phase));
      try {
        await operations.synchronize(target);
      } catch (error) {
        const sourceHashes = Object.fromEntries(
          [canonical, projection].map((root) => [
            root,
            createHash("sha256").update(read(root)).digest("hex"),
          ]),
        );
        console.error(
          JSON.stringify({
            ...phase,
            sourceHashes,
            baseline: await operations.baselineDocument(),
            checkpoint: operations.current().checkpoint_json,
            pendingTarget: operations.current().pending_target,
          }),
        );
        throw error;
      }
    });
  async function observe(
    target: Direction,
    before: (action: LocalWorkspaceManifestAction, store: LocalWorkspaceStore) => Promise<void>,
    beforeUpdate?: (
      patch: Parameters<LocalWorkspaceStore["update"]>[1],
      store: LocalWorkspaceStore,
    ) => Promise<void>,
  ) {
    return withLocalWorkspaceStore({ ...owner, worktreeId }, async (store) => {
      const wrapped: LocalWorkspaceStore = {
        ...store,
        manifest: async (row, action) => {
          await before(action, store);
          return store.manifest(row, action);
        },
        update: async (...args) => {
          await beforeUpdate?.(args[1], store);
          return store.update(...args);
        },
      };
      await projectionOperations(owner, wrapped, store.get()).synchronize(target);
    });
  }
  try {
    if (values.child === "exercise") {
      assert.equal(
        await withLocalWorkspaceProjection(owner, (operations) => operations.prepare()),
        projection,
      );
      // Source-only checkout initialization is ordinary-directory based. Convert
      // this synthetic fixture before it is ever attached to a guest runtime.
      fs.renameSync(projection, `${projection}.initial`);
      btrfs("subvolume", "create", projection);
      execFileSync("cp", ["-a", `${projection}.initial/.`, projection]);
      fs.rmSync(`${projection}.initial`, { recursive: true });
      for (const target of ["canonical", "projection"] as const) {
        await synchronize(target);
        let observed = false;
        await observe(target, async (action, store) => {
          if (action.kind === "scan") {
            assert(
              action.filesystem?.changedRoots,
              `Unchanged source must use the accepted native checkpoint: ${store.get()?.filesystem_checkpoints_json}`,
            );
            assert(
              action.filesystem.changedRoots.every((root) => root === ".git"),
              "No user paths changed",
            );
            observed = true;
          }
        });
        assert(observed);
      }
      const guestEdit = editWithinGeneration(projection, "guest001\n");
      await synchronize("canonical");
      assert.equal(read(canonical), "guest001\n");
      await observe("projection", async (action) => {
        if (action.kind === "scan") {
          const roots = action.filesystem?.changedRoots;
          assert(
            roots,
            "Accepted guest edits must carry their changed root into the older host checkpoint",
          );
          assert(roots.includes("source.txt"), "Changed source must be scanned");
          assert(
            !roots.includes(".gitignore"),
            "Direction changes must leave unchanged tracked paths outside the scan",
          );
        }
      });
      const hostEdit = editWithinGeneration(canonical, "host0001\n");
      await synchronize("projection");
      assert.equal(read(projection), "host0001\n");
      await observe("canonical", async (action) => {
        if (action.kind === "scan") {
          assert(
            action.filesystem?.changedRoots?.includes("source.txt"),
            "Accepted host edits must carry their changed root into the older guest checkpoint",
          );
        }
      });
      assert(
        !fs.existsSync(path.join(projection, ".env.local")),
        "Ignored host secret must not reach the guest",
      );
      assert(
        !fs
          .readFileSync(path.join(projection, ".git", "config"), "utf8")
          .includes("host-only-marker"),
      );
      fs.writeFileSync(path.join(canonical, "admitted.txt"), "explicitly staged host content\n");
      await synchronize("projection");
      assert(!fs.existsSync(path.join(projection, "admitted.txt")));
      git(canonical, "add", "-f", "admitted.txt");
      await synchronize("projection");
      assert.equal(
        fs.readFileSync(path.join(projection, "admitted.txt"), "utf8"),
        "explicitly staged host content\n",
      );
      // Guest Git metadata is excluded from sync, but an alias there still
      // changes admitted bytes. Guest-created .env files are ordinary edits.
      const excludedAlias = path.join(projection, ".git", "proof-hardlink");
      fs.linkSync(path.join(projection, "source.txt"), excludedAlias);
      fs.writeFileSync(excludedAlias, "alias001\n");
      await synchronize("canonical");
      assert.equal(read(canonical), "alias001\n");
      assert.equal(
        fs.readFileSync(path.join(canonical, ".env.local"), "utf8"),
        "synthetic-host-secret\n",
      );
      fs.unlinkSync(excludedAlias);
      await synchronize("canonical");
      process.send?.({ kind: "passed", phase: "exercise", guestEdit, hostEdit });
    } else if (values.child === "crash" || values.child === "recover") {
      assert(values.direction === "canonical" || values.direction === "projection");
      const target = values.direction;
      const source = target === "canonical" ? projection : canonical;
      const destination = target === "canonical" ? canonical : projection;
      const point = values.point ?? "before-scan";
      assert(point === "before-scan" || point === "after-retirement");
      if (values.child === "crash") {
        await synchronize(target);
        edit(source, "crash001\n");
        await observe(
          target,
          async (action, store) => {
            if (point !== "before-scan" || action.kind !== "scan") {
              return;
            }
            const pending = receipt(store.get()!.filesystem_checkpoints_json).pending;
            assert.equal(pending?.target, target);
            assert(pending);
            const candidate = path.join(checkpoints, pending.token);
            assert.equal(read(candidate), "crash001\n");
            btrfs("subvolume", "show", candidate);
            process.send?.({ kind: "ready", point, token: pending.token });
            await new Promise<void>(() => {});
          },
          async (patch, store) => {
            if (point !== "after-retirement" || !patch.filesystem_checkpoints_json) {
              return;
            }
            const current = receipt(store.get()!.filesystem_checkpoints_json);
            const next = receipt(patch.filesystem_checkpoints_json);
            const pending = current.pending;
            if (!pending || next.pending || next.accepted[target]?.token !== pending.token) {
              return;
            }
            const previous = current.accepted[target];
            assert(previous, "Retirement requires an existing accepted checkpoint");
            assert.equal(pending.target, target);
            assert(
              !fs.existsSync(path.join(checkpoints, previous.token)),
              "Retirement crash must happen after old snapshot deletion",
            );
            const durable = checkpointFromDisk();
            assert.equal(durable.pending?.token, pending.token);
            assert.equal(durable.accepted[target]?.token, previous.token);
            const candidate = path.join(checkpoints, pending.token);
            btrfs("subvolume", "show", candidate);
            for (const root of [source, destination, candidate]) {
              assert.equal(read(root), "crash001\n", "Content must settle before retirement");
            }
            process.send?.({
              kind: "ready",
              point,
              token: pending.token,
              retiredToken: previous.token,
            });
            await new Promise<void>(() => {});
          },
        );
        assert.fail("Crash child must be killed before acceptance");
      } else {
        const pending = checkpointFromDisk().pending;
        assert(pending);
        let fullScan = false;
        await observe(target, async (action) => {
          if (action.kind === "scan") {
            assert.equal(
              action.filesystem?.changedRoots,
              undefined,
              "Restart must discard incremental eligibility",
            );
            fullScan = true;
          }
        });
        assert(fullScan);
        assert.equal(
          read(destination),
          "newest01\n",
          "Recovery must publish newer source, never the killed snapshot",
        );
        assert(
          !fs.existsSync(path.join(checkpoints, pending.token)),
          "Interrupted snapshot must be retired",
        );
        await withLocalWorkspaceProjection(owner, async (operations) => {
          assert.equal(
            receipt(operations.current().filesystem_checkpoints_json).pending,
            undefined,
          );
        });
        process.send?.({ kind: "passed", phase: `recover-${target}`, point, fullScan });
      }
    } else {
      assert.equal(values.child, "cleanup");
      await withLocalWorkspaceProjection(owner, (operations) => operations.expire());
      process.send?.({ kind: "passed", phase: "cleanup" });
    }
  } finally {
    await state.closeOpenClawStateDatabaseAsync();
    await (
      await import("../../src/shared/global-singleton.js")
    ).drainGlobalSingletonLifecycleState();
    process.disconnect?.();
  }
}

async function orchestrate() {
  fs.mkdirSync(output);
  btrfs("subvolume", "create", fixture);
  const results: unknown[] = [];
  try {
    for (const directory of [
      repository,
      stateRoot,
      path.join(fixture, "home"),
      path.join(fixture, "tmp"),
    ]) {
      fs.mkdirSync(directory);
    }
    fs.writeFileSync(
      path.join(fixture, "openclaw.json"),
      JSON.stringify(BASE_GATEWAY_BENCH_CONFIG),
    );
    git(repository, "init", "--quiet", "-b", "main");
    git(repository, "config", "user.name", "Synthetic proof");
    git(repository, "config", "user.email", "proof@example.invalid");
    git(repository, "config", "proof.marker", "host-only-marker");
    fs.writeFileSync(path.join(repository, "source.txt"), "start001\n");
    fs.writeFileSync(path.join(repository, ".gitignore"), ".env.local\nadmitted.txt\n");
    git(repository, "add", ".");
    git(repository, "commit", "--quiet", "-m", "synthetic base");
    btrfs("subvolume", "create", canonical);
    git(repository, "worktree", "add", "--quiet", "-b", "openclaw/proof", canonical);
    fs.writeFileSync(path.join(canonical, ".env.local"), "synthetic-host-secret\n");
    async function run(phase: string, direction?: Direction, point?: CrashPoint) {
      const label = [phase, direction, point].filter(Boolean).join("-");
      const log = fs.openSync(path.join(output, `${label}.log`), "w");
      const subprocess = spawn(
        process.execPath,
        [
          "--import",
          fileURLToPath(new URL("../tsx.mjs", import.meta.url)),
          fileURLToPath(import.meta.url),
          "--output",
          output,
          "--child",
          phase,
          ...(direction ? ["--direction", direction] : []),
          ...(point ? ["--point", point] : []),
        ],
        { stdio: ["ignore", log, log, "ipc"] },
      );
      fs.closeSync(log);
      // Recovery waits out the normal 60-second lease after SIGKILL; no lease SQL is edited.
      const timeout = setTimeout(() => subprocess.kill("SIGKILL"), 300_000);
      let ready = false;
      let passed = false;
      let retiredToken: string | undefined;
      subprocess.on("message", (message: unknown) => {
        if (!message || typeof message !== "object" || !("kind" in message)) {
          return;
        }
        results.push(message);
        if (message.kind === "ready") {
          ready = true;
          if ("retiredToken" in message && typeof message.retiredToken === "string") {
            retiredToken = message.retiredToken;
          }
          subprocess.kill("SIGKILL");
        }
        passed ||= message.kind === "passed";
      });
      const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>(
        (resolve, reject) => {
          subprocess.once("error", reject);
          subprocess.once("exit", (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
        },
      ).finally(() => clearTimeout(timeout));
      if (phase === "crash") {
        assert(ready, `Crash child never reached durable checkpoint; see ${label}.log`);
        assert.equal(signal, "SIGKILL");
        const durable = checkpointFromDisk();
        const pending = durable.pending;
        assert.equal(
          pending?.target,
          direction,
          "Pending receipt must survive SIGKILL in canonical SQLite",
        );
        assert(pending && fs.existsSync(path.join(checkpoints, pending.token)));
        if (point === "after-retirement") {
          assert(direction && retiredToken);
          assert.equal(durable.accepted[direction]?.token, retiredToken);
          assert(!fs.existsSync(path.join(checkpoints, retiredToken)));
        }
        edit(direction === "canonical" ? projection : canonical, "newest01\n");
      } else {
        assert.equal(code, 0, `${label} failed; inspect its log (signal ${signal})`);
        assert(passed);
      }
    }
    await run("exercise");
    for (const point of [undefined, "after-retirement"] as const) {
      for (const target of ["canonical", "projection"] as const) {
        await run("crash", target, point);
        await run("recover", target, point);
      }
    }
    await run("cleanup");
    fs.writeFileSync(
      path.join(output, "report.json"),
      JSON.stringify({ passed: true, results }, null, 2) + "\n",
    );
    console.log(
      `Native checkpoint and SIGKILL recovery proof passed: ${path.join(output, "report.json")}`,
    );
  } finally {
    btrfs("subvolume", "delete", "--recursive", fixture);
  }
}

await (values.child ? child() : orchestrate());
