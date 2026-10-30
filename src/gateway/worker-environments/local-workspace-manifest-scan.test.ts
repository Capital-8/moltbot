import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { deserialize } from "node:v8";
import { inflateRawSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as btrfs from "../../agents/worktrees/filesystem-btrfs-checkpoints.js";
import { requireGit } from "../../agents/worktrees/git.js";
import { extractSqliteTableSchema } from "../../infra/sqlite-schema-sql.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../../state/openclaw-state-schema.js";
import {
  localWorkspaceDigestBytes,
  prepareLocalWorkspaceTreePacks,
  type LocalWorkspacePreparation,
} from "./local-workspace-cas.js";
import {
  beginLocalWorkspaceSweepInDatabase,
  deleteLocalWorkspaceSweepBatchInDatabase,
  prepareLocalWorkspaceContentInDatabase,
  readLocalWorkspaceSweepCandidates,
  readLocalWorkspaceTree,
} from "./local-workspace-cas.kernel.js";
import { localWorkspaceFilesystemCheckpoints } from "./local-workspace-filesystem-checkpoints.js";
import {
  executeLocalWorkspaceManifestRead,
  readLocalWorkspaceManifestRows,
  type LocalWorkspaceManifestAction,
} from "./local-workspace-manifest-scan.js";
import {
  createLocalWorkspaceManifestTree,
  localWorkspaceManifestRootReference,
} from "./local-workspace-manifest-tree.js";
import { mutateLocalWorkspaceProjection } from "./local-workspace-store.kernel.js";
import { localWorkspaceProjectionFixture } from "./local-workspace-store.test-support.js";
import type { LocalWorkspaceMutation } from "./local-workspace-store.types.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

afterEach(() => vi.restoreAllMocks());

it.each(["edit", "delete one-child root", "delete two-sided root"])(
  "keeps a complete incremental pack graph through acceptance and GC after %s",
  async (operation) => {
    using db = new DatabaseSync(":memory:");
    const root = await fs.realpath(dirs.make("workspace-incremental-scan-"));
    const files = Array.from(
      { length: operation === "delete one-child root" ? 2 : 64 },
      (_, index) => ({
        path: `edited/deep/file-${String(index).padStart(4, "0")}.txt`,
        type: "file" as const,
        mode: 0o644,
        size: 3,
        sha256: hash("old"),
      }),
    );
    const directories = ["edited", "edited/deep", "untouched"];
    const nodes = [
      ...directories.map((entryPath) => ({ path: entryPath, type: "directory" as const })),
      ...files,
      ...["a", "b"].map((name) => ({
        path: `untouched/${name}.txt`,
        type: "file" as const,
        mode: 0o644,
        size: 3,
        sha256: hash("old"),
      })),
    ];
    await Promise.all(
      directories.map((entryPath) => fs.mkdir(path.join(root, entryPath), { recursive: true })),
    );
    await Promise.all(
      nodes
        .filter((node) => node.type === "file")
        .map((node) => fs.writeFile(path.join(root, node.path), "old")),
    );
    await requireGit(root, ["init", "--quiet"]);
    await requireGit(root, ["add", "."]);
    const baseline = createLocalWorkspaceManifestTree(nodes);
    const treeRoot = localWorkspaceDigestBytes(baseline.get("")!.treeRef);
    const row = {
      ...localWorkspaceProjectionFixture("incremental", root),
      tree_root_digest: treeRoot,
      baseline_ref: localWorkspaceManifestRootReference(baseline, "a".repeat(40)),
    };
    mutateLocalWorkspaceProjection(db, row.worktree_id, { kind: "create", row });
    const prepare = (batches: readonly Uint8Array[]) => {
      for (const batch of batches) {
        const preparation = deserialize(inflateRawSync(batch)) as LocalWorkspacePreparation;
        prepareLocalWorkspaceContentInDatabase(db, preparation);
      }
    };
    prepare(prepareLocalWorkspaceTreePacks(baseline));
    const directoryRoot = baseline.get(baseline.get("edited/deep")!.children!)!;
    const changedPath = operation === "edit" ? files[32]!.path : directoryRoot.node.path;
    if (operation === "edit") {
      await fs.writeFile(path.join(root, changedPath), "new");
    } else {
      expect(
        [directoryRoot.left, directoryRoot.right].filter((child) => child !== null),
      ).toHaveLength(operation === "delete one-child root" ? 1 : 2);
      await fs.unlink(path.join(root, changedPath));
    }
    const expected = createLocalWorkspaceManifestTree(
      nodes.flatMap((node) =>
        node.path !== changedPath
          ? [node]
          : operation === "edit"
            ? [{ ...files[32]!, sha256: hash("new") }]
            : [],
      ),
    );
    const promoted = expected.get(expected.get("edited/deep")!.children!)!;
    // Initial publication must not accidentally supply the pack needed after deletion.
    expect(
      db
        .prepare("SELECT 1 FROM local_workspace_tree_packs WHERE tree_digest = ?")
        .get(localWorkspaceDigestBytes(promoted.treeRef)),
    ).toBeUndefined();
    const input = {
      id: row.worktree_id,
      revision: 0,
      action: { kind: "scan" as const, target: "projection" as const, canonicalRoot: root },
    };
    const result = await executeLocalWorkspaceManifestRead(
      readLocalWorkspaceManifestRows(db, input),
      input.action,
    );
    if (result.kind !== "scan") {
      throw new Error("Missing incremental scan");
    }
    const counter = trackSqliteStatementExecutions(db, ["preparationReads"], (sql) =>
      /^select\b.*"sweep_epoch".*"local_workspace_tree_packs"/i.test(sql)
        ? "preparationReads"
        : null,
    );
    try {
      prepare(result.preparations!);
      expect(counter.counts.preparationReads).toBe(1);
    } finally {
      counter.restore();
    }
    const nextRoot = localWorkspaceDigestBytes(result.treeRoot!);
    const { preparations: _preparations, observation: _observation, ...checkpoint } = result;
    let revision = 0;
    if (operation === "edit") {
      mutateLocalWorkspaceProjection(db, row.worktree_id, {
        kind: "update",
        revision: 0,
        patch: { checkpoint_json: JSON.stringify(checkpoint) },
      });
      db.exec(extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "config_machine_state"));
      beginLocalWorkspaceSweepInDatabase(db);
      const pendingEpoch = beginLocalWorkspaceSweepInDatabase(db);
      expect(readLocalWorkspaceSweepCandidates(db, pendingEpoch).packs).toEqual([]);
      expect(readLocalWorkspaceTree(db, treeRoot)).toEqual(baseline);
      expect(readLocalWorkspaceTree(db, nextRoot)).toEqual(expected);
      revision = 1;
    }
    mutateLocalWorkspaceProjection(db, row.worktree_id, {
      kind: "update",
      revision,
      patch: { checkpoint_json: null },
      manifest: checkpoint,
    });
    expect(
      readLocalWorkspaceManifestRows(db, { ...input, revision: revision + 1 }).records,
    ).toEqual(expected);
    expect(result.preparations).toHaveLength(1);
    const packs = result.preparations!.flatMap(
      (batch) => (deserialize(inflateRawSync(batch)) as LocalWorkspacePreparation).packs!,
    );
    // The three path components select three directory packs plus the sentinel root pack.
    expect(packs).toHaveLength(4);
    expect(result.resultingRoot).toBe(
      localWorkspaceManifestRootReference(expected, row.base_commit),
    );
    if (operation !== "edit") {
      db.exec(extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "config_machine_state"));
      beginLocalWorkspaceSweepInDatabase(db);
      beginLocalWorkspaceSweepInDatabase(db);
    }
    const acceptedEpoch = beginLocalWorkspaceSweepInDatabase(db);
    const garbage = readLocalWorkspaceSweepCandidates(db, acceptedEpoch);
    expect(garbage.packs.length).toBeGreaterThan(0);
    deleteLocalWorkspaceSweepBatchInDatabase(db, acceptedEpoch, garbage);
    expect(readLocalWorkspaceTree(db, nextRoot)).toEqual(expected);
  },
);

async function repairFixture(historicalCache = false) {
  const root = await fs.realpath(dirs.make("workspace-baseline-repair-"));
  const projection = path.join(root, "projection");
  const canonical = path.join(root, "canonical");
  for (const directory of [projection, canonical]) {
    await fs.mkdir(path.join(directory, "nested"), { recursive: true });
    await fs.writeFile(path.join(directory, "nested/file.txt"), "baseline");
    if (historicalCache) {
      await fs.mkdir(path.join(directory, ".openclaw/.pnpm-store"), { recursive: true });
      await fs.writeFile(path.join(directory, ".openclaw/.pnpm-store/cache"), "baseline");
      await fs.mkdir(path.join(directory, "node_modules"));
      await fs.writeFile(path.join(directory, "node_modules/installed.js"), "local dependency");
    }
  }
  await requireGit(canonical, ["init", "--quiet"]);
  await requireGit(canonical, ["add", "nested/file.txt"]);
  const records = createLocalWorkspaceManifestTree([
    { path: "nested", type: "directory" },
    { path: "nested/file.txt", type: "file", mode: 0o644, size: 8, sha256: hash("baseline") },
    ...(historicalCache
      ? [
          { path: ".openclaw", type: "directory" as const },
          { path: ".openclaw/.pnpm-store", type: "directory" as const },
          {
            path: ".openclaw/.pnpm-store/cache",
            type: "file" as const,
            mode: 0o644,
            size: 8,
            sha256: hash("baseline"),
          },
        ]
      : []),
  ]);
  const treeRoot = localWorkspaceDigestBytes(records.get("")!.treeRef);
  const snapshot = {
    row: {
      revision: 7,
      projection_path: projection,
      base_commit: "a".repeat(40),
      source_paths_json: '["nested/file.txt"]',
      baseline_json: null,
      baseline_ref: localWorkspaceManifestRootReference(records, "a".repeat(40)),
      tree_root_digest: treeRoot,
      source_paths_digest: null,
      canonical_fingerprints: null,
      projection_fingerprints: null,
      pending_ref: "refs/openclaw/results/preserved",
      checkpoint_json: null as string | null,
    },
    records: new Map(),
  };
  return { projection, canonical, snapshot, treeRoot, records };
}

it("uses checkpoint deltas only for the accepted content and current host admission", async () => {
  const { canonical, projection, snapshot, records } = await repairFixture();
  const action = { kind: "scan" as const, target: "projection" as const, canonicalRoot: canonical };
  const capture = (
    filesystem: Extract<LocalWorkspaceManifestAction, { kind: "scan" }>["filesystem"],
  ) =>
    executeLocalWorkspaceManifestRead(
      { ...snapshot, records: new Map(records) },
      { ...action, filesystem },
    );
  const first = await capture({ root: canonical });
  if (first.kind !== "scan") {
    throw new Error("Missing snapshot inventory");
  }
  const checkpoint = {
    root: canonical,
    previousRoot: snapshot.row.baseline_ref!,
    admissionRef: first.filesystemAdmissionRef!,
    changedRoots: [] as string[],
  };
  const lstat = vi.spyOn(fs, "lstat");
  const unchanged = await capture(checkpoint);
  expect(unchanged.kind === "scan" && unchanged.resultingRoot).toBe(snapshot.row.baseline_ref);
  expect(unchanged.kind === "scan" && unchanged.filesystemChangedRoots).toEqual([]);
  expect(lstat.mock.calls.filter(([file]) => String(file).endsWith("nested/file.txt"))).toEqual([]);

  const file = path.join(canonical, "nested/file.txt");
  const before = await fs.stat(file);
  await fs.writeFile(file, "modified");
  await fs.utimes(file, before.atime, before.mtime);
  const edited = await capture({ ...checkpoint, changedRoots: ["nested"] });
  expect(edited.kind === "scan" && edited.currentManifestRaw).toContain(hash("modified"));
  expect(edited.kind === "scan" && edited.filesystemChangedRoots).toEqual(["nested"]);
  const stale = await capture({ ...checkpoint, previousRoot: "stale" });
  expect(stale.kind === "scan" && stale.currentManifestRaw).toContain(hash("modified"));

  // The host index can acquire an existing ignored file without a subvolume edit.
  await fs.writeFile(path.join(canonical, "new.txt"), "host admission");
  await requireGit(canonical, ["add", "new.txt"]);
  const admitted = await capture(checkpoint);
  expect(admitted.kind === "scan" && admitted.currentManifestRaw).toContain(hash("host admission"));
  expect(await fs.readFile(path.join(projection, "nested/file.txt"), "utf8")).toBe("baseline");
});

async function filesystemCheckpointFixture() {
  const { canonical, projection } = await repairFixture();
  const identities = new Map<string, btrfs.BtrfsCheckpointIdentity>(
    [canonical, projection].map((root) => [
      root,
      { uuid: randomUUID(), parentUuid: null, device: "1", inode: "256" },
    ]),
  );
  vi.spyOn(btrfs, "readBtrfsCheckpointIdentity").mockImplementation(
    async (root) => identities.get(root) ?? null,
  );
  vi.spyOn(btrfs, "createBtrfsCheckpoint").mockImplementation(async (source, root) => {
    const identity = {
      uuid: randomUUID(),
      parentUuid: identities.get(source)!.uuid,
      device: "2",
      inode: "256",
    };
    identities.set(root, identity);
    return identity;
  });
  const diff = vi.spyOn(btrfs, "diffBtrfsCheckpoints").mockResolvedValue(new Set());
  const remove = vi.spyOn(btrfs, "deleteBtrfsCheckpoint").mockImplementation(async (root) => {
    identities.delete(root);
    return true;
  });
  const row = { baseline_ref: "A", filesystem_checkpoints_json: null as string | null };
  const update = vi.fn(async (patch: { filesystem_checkpoints_json: string | null }) => {
    Object.assign(row, patch);
  });
  const checkpoints = localWorkspaceFilesystemCheckpoints({
    projectionPath: projection,
    current: () => row,
    update,
    assertCurrent() {},
    signal: new AbortController().signal,
  });
  return { canonical, projection, identities, diff, remove, row, update, checkpoints };
}

it("retains baseline changes across direction switches even when the native delta is empty", async () => {
  const { canonical, projection, diff, row, checkpoints } = await filesystemCheckpointFixture();
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "linux" });
  try {
    for (const target of ["canonical", "projection"] as const) {
      const prepared = await checkpoints.prepare(
        target,
        target === "canonical" ? projection : canonical,
      );
      expect(prepared).toBeDefined();
      await checkpoints.accept(prepared!, {
        previousRoot: "A",
        resultingRoot: "A",
        filesystemAdmissionRef: "admission",
        filesystemChangedRoots: [],
      });
    }
    // Guest A→B advances the shared baseline; the older host snapshot remains A.
    diff.mockResolvedValue(new Set(["nested"]));
    const guest = await checkpoints.prepare("canonical", projection);
    row.baseline_ref = "B";
    await checkpoints.accept(guest!, {
      previousRoot: "A",
      resultingRoot: "B",
      filesystemAdmissionRef: "admission",
      filesystemChangedRoots: ["nested"],
    });
    // After an external host revert B→A, A→A contributes no native changes.
    // The manifest still holds B, so the retained baseline delta must be scanned.
    diff.mockResolvedValue(new Set());
    const reverted = await checkpoints.prepare("projection", canonical);
    expect(reverted?.previousRoot).toBe("B");
    expect(reverted?.changedRoots).toEqual(["nested"]);
    row.baseline_ref = "A";
    await checkpoints.accept(reverted!, {
      previousRoot: "B",
      resultingRoot: "A",
      filesystemAdmissionRef: "admission",
      filesystemChangedRoots: ["nested"],
    });
    const unchanged = await checkpoints.prepare("projection", canonical);
    expect(unchanged?.changedRoots).toEqual([]);
    await checkpoints.accept(unchanged!, {
      previousRoot: "A",
      resultingRoot: "A",
      filesystemAdmissionRef: "admission",
      filesystemChangedRoots: [],
    });
    // Refresh/recovery without a known transition must still use a full scan.
    row.baseline_ref = "unrecorded-transition";
    expect((await checkpoints.prepare("projection", canonical))?.changedRoots).toBeUndefined();
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
});

it.each(["success", "acceptance failure", "deferred deletion"] as const)(
  "keeps rotation cleanup recoverable with one acceptance write: %s",
  async (outcome) => {
    const { projection, identities, diff, remove, row, update, checkpoints } =
      await filesystemCheckpointFixture();
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      const facts = {
        previousRoot: "A",
        resultingRoot: "A",
        filesystemAdmissionRef: "admission",
        filesystemChangedRoots: [],
      };
      const previous = (await checkpoints.prepare("canonical", projection))!;
      await checkpoints.accept(previous, facts);
      update.mockClear();
      diff.mockResolvedValue(new Set([".git"]));
      const prepared = (await checkpoints.prepare("canonical", projection))!;
      const reserved = row.filesystem_checkpoints_json;
      remove.mockImplementationOnce(async (root, identity) => {
        expect(root).toBe(previous.root);
        expect(identity).toEqual(previous.snapshot);
        // The durable reservation owns recovery until retirement finishes.
        expect(row.filesystem_checkpoints_json).toBe(reserved);
        if (outcome === "deferred deletion") {
          return false;
        }
        identities.delete(root);
        return true;
      });
      if (outcome === "acceptance failure") {
        update.mockRejectedValueOnce(new Error("acceptance unavailable"));
        await expect(checkpoints.accept(prepared, facts)).rejects.toThrow("acceptance unavailable");
        expect(identities.has(previous.root)).toBe(false);
        expect(row.filesystem_checkpoints_json).toBe(reserved);
        // Recovery must ignore native equality after an interrupted rotation.
        const recovered = await checkpoints.prepare("canonical", projection);
        expect(recovered).toBeDefined();
        expect(recovered!.changedRoots).toBeUndefined();
        expect(identities.has(prepared.root)).toBe(false);
      } else {
        await checkpoints.accept(prepared, facts);
        expect(update).toHaveBeenCalledTimes(2);
        expect(remove).toHaveBeenCalledTimes(1);
        expect(JSON.parse(row.filesystem_checkpoints_json!)).toMatchObject({
          accepted: { canonical: { token: prepared.token } },
          garbage:
            outcome === "deferred deletion"
              ? [expect.objectContaining({ token: previous.token })]
              : [],
        });
        expect(JSON.parse(row.filesystem_checkpoints_json!)).not.toHaveProperty("pending");
        if (outcome === "deferred deletion") {
          expect(identities.has(previous.root)).toBe(true);
          await checkpoints.prepare("canonical", projection);
          expect(remove).toHaveBeenCalledTimes(2);
          expect(identities.has(previous.root)).toBe(false);
          expect(JSON.parse(row.filesystem_checkpoints_json!).garbage).toEqual([]);
        }
      }
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  },
);

it.each([
  ["projection", false],
  ["canonical", false],
  ["checkpoint", false],
  ["projection", true],
  ["checkpoint", true],
] as const)(
  "reconstructs a collected baseline from the verified %s filesystem (historical cache: %s)",
  async (matching, historicalCache) => {
    const { projection, canonical, snapshot, treeRoot, records } =
      await repairFixture(historicalCache);
    if (matching === "checkpoint") {
      await fs.writeFile(path.join(canonical, "nested/file.txt"), "pending edit");
      const scan = await executeLocalWorkspaceManifestRead(
        { ...snapshot, records },
        {
          kind: "scan",
          target: "projection",
          canonicalRoot: canonical,
        },
      );
      snapshot.row.checkpoint_json = JSON.stringify(scan);
    }
    if (matching === "canonical") {
      // A later guest name must not enroll unrelated canonical bytes or spoil
      // an already matching canonical candidate.
      await fs.writeFile(path.join(projection, "unaccepted.txt"), "guest addition");
      await fs.writeFile(path.join(canonical, "unaccepted.txt"), "host-only bytes");
    }
    const divergent = matching === "projection" ? canonical : projection;
    await fs.writeFile(path.join(divergent, "nested/file.txt"), "preserved live edit");
    const result = await executeLocalWorkspaceManifestRead(snapshot, {
      kind: "repair",
      canonicalRoot: canonical,
    });
    expect(result.kind).toBe("replace");
    if (result.kind !== "replace") {
      throw new Error("Missing prepared repair");
    }
    const mutation = deserialize(inflateRawSync(result.update.mutation)) as LocalWorkspaceMutation;
    expect(mutation).toEqual({
      kind: "update",
      revision: 7,
      patch: {
        tree_root_digest: treeRoot,
        canonical_fingerprints: null,
        projection_fingerprints: null,
      },
    });
    const nodes = result.update.preparations!.flatMap((batch) => {
      const preparation = deserialize(inflateRawSync(batch)) as LocalWorkspacePreparation;
      return preparation.packs!.flatMap((pack) => pack.records);
    });
    expect(nodes.find(({ node }) => node.path === "nested/file.txt")!.node).toMatchObject({
      sha256: hash("baseline"),
      size: 8,
    });
    expect(nodes.find(({ node }) => node.path === "")!.treeRef).toBe(
      `sha256:${Buffer.from(treeRoot).toString("hex")}`,
    );
    expect(await fs.readFile(path.join(divergent, "nested/file.txt"), "utf8")).toBe(
      "preserved live edit",
    );
  },
);

it.each(["different", "identical"] as const)(
  "preserves %s later edits when neither filesystem matches the exact missing baseline",
  async (edits) => {
    const { projection, canonical, snapshot } = await repairFixture(true);
    await fs.writeFile(path.join(projection, "nested/file.txt"), "guest edit");
    const hostEdit = edits === "identical" ? "guest edit" : "host edit";
    await fs.writeFile(path.join(canonical, "nested/file.txt"), hostEdit);
    await expect(
      executeLocalWorkspaceManifestRead(snapshot, {
        kind: "repair",
        canonicalRoot: canonical,
      }),
    ).rejects.toThrow("neither workspace matches the saved baseline");
    expect(await fs.readFile(path.join(projection, "nested/file.txt"), "utf8")).toBe("guest edit");
    expect(await fs.readFile(path.join(canonical, "nested/file.txt"), "utf8")).toBe(hostEdit);
  },
);
