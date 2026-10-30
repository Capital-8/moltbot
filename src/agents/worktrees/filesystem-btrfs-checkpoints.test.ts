import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import * as execRunner from "../../process/exec-runner.js";
import {
  createBtrfsCheckpoint,
  deleteBtrfsCheckpoint,
  diffBtrfsCheckpoints,
  readBtrfsCheckpointIdentity,
  type BtrfsCheckpoint,
} from "./filesystem-btrfs-checkpoints.js";
import { parseBtrfsCheckpointChanges } from "./filesystem-btrfs-stream.js";

const identity = {
  snapshotUuid: "11111111-2222-3333-4444-555555555555",
  parentUuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
};
// Independent v1 wire fixtures: little-endian send.h headers/TLVs and CRC32C(seed=0).
const fixtures = {
  unchanged:
    "YnRyZnMtc3RyZWFtAAEAAAAoAAAAAgDM2wvNAQAQABEREREiIjMzRERVVVVVVVUUABAAqqqqqru7zMzd3e7u7u7u7g4AAAAUANDy9KoPAAoAc291cmNlLnR4dAAAAAAVAFBsyZ0=",
  changed:
    "YnRyZnMtc3RyZWFtAAEAAAAoAAAAAgDM2wvNAQAQABEREREiIjMzRERVVVVVVVUUABAAqqqqqru7zMzd3e7u7u7u7g8AAAAWAG9YGm4PAAsAc3JjL2ZpbGUudHMWAAAACQC2OQv2DwAHAG9sZC9kaXIQAAcAbmV3L2RpchkAAAAKAJeKnsgPAAYAbGlua2VkEQALAHNyYy9maWxlLnRzIgAAAAgAUgR7Bw8ADQBsaW5rcy/DpAoudHh0EQANAC4uLy4uL291dHNpZGUOAAAAEgDzEWyODwAKAGV4ZWN1dGFibGULAAAACwBKZRK+DwAHAGRlbGV0ZWQUAAAADQDjtsQQDwAQAGlnbm9yZWQtbWV0YWRhdGERAAAAEwC04opiDwANAGlnbm9yZWQtb3duZXIAAAAAFQBQbMmd",
  unknown:
    "YnRyZnMtc3RyZWFtAAEAAAAoAAAAAgDM2wvNAQAQABEREREiIjMzRERVVVVVVVUUABAAqqqqqru7zMzd3e7u7u7u7g8AAAAXAIIlEGMPAAsAc3JjL2ZpbGUudHMAAAAAFQBQbMmd",
  unsafe:
    "YnRyZnMtc3RyZWFtAAEAAAAoAAAAAgDM2wvNAQAQABEREREiIjMzRERVVVVVVVUUABAAqqqqqru7zMzd3e7u7u7u7g0AAAAWAAp8Hr8PAAkALi4vZXNjYXBlAAAAABUAUGzJnQ==",
  duplicate:
    "YnRyZnMtc3RyZWFtAAEAAAAoAAAAAgDM2wvNAQAQABEREREiIjMzRERVVVVVVVUUABAAqqqqqru7zMzd3e7u7u7u7hEAAAAWANiR12UPAAQAc2FmZQ8ABQBzYWZlMgAAAAAVAFBsyZ0=",
  nonUtf8:
    "YnRyZnMtc3RyZWFtAAEAAAAoAAAAAgDM2wvNAQAQABEREREiIjMzRERVVVVVVVUUABAAqqqqqru7zMzd3e7u7u7u7ggAAAAWABTB5/0PAAQAYmFk/wAAAAAVAFBsyZ0=",
};
const decode = (name: keyof typeof fixtures) => Buffer.from(fixtures[name], "base64");

it("selects content and namespace roots without turning symlink targets or read timestamps into paths", () => {
  expect(parseBtrfsCheckpointChanges(decode("unchanged"), identity)).toEqual({
    roots: new Set(),
    paths: new Set(),
  });
  expect(parseBtrfsCheckpointChanges(decode("changed"), identity)).toEqual({
    roots: new Set(["src", "old", "new", "linked", "links", "executable", "deleted"]),
    paths: new Set([
      "src/file.ts",
      "old/dir",
      "new/dir",
      "linked",
      "links/ä\n.txt",
      "executable",
      "deleted",
    ]),
  });
});

it("requires complete, checksummed v1 deltas for the exact parent and snapshot", () => {
  const stream = decode("changed");
  const corrupted = Buffer.from(stream);
  corrupted[corrupted.length - 1] = corrupted.at(-1)! ^ 1;
  const otherVersion = Buffer.from(stream);
  otherVersion.writeUInt32LE(2, 13);
  for (const input of [
    corrupted,
    otherVersion,
    stream.subarray(1),
    stream.subarray(0, -10),
    Buffer.concat([stream, Buffer.of(0)]),
    ...(["unknown", "unsafe", "duplicate", "nonUtf8"] as const).map(decode),
  ]) {
    expect(parseBtrfsCheckpointChanges(input, identity)).toBeNull();
  }
  for (const key of ["parentUuid", "snapshotUuid"] as const) {
    const otherUuid = key === "parentUuid" ? identity.snapshotUuid : identity.parentUuid;
    expect(parseBtrfsCheckpointChanges(stream, { ...identity, [key]: otherUuid })).toBeNull();
  }
});

it("never probes or mutates a filesystem after checkpoint authority is revoked", async () => {
  const refused = new Error("checkpoint authority revoked");
  const options = {
    commitGuard: () => {
      throw refused;
    },
  };
  await expect(readBtrfsCheckpointIdentity("/unused", options)).rejects.toBe(refused);
  await expect(
    createBtrfsCheckpoint("/unused", "/unused-new", options, {
      uuid: identity.snapshotUuid,
      parentUuid: null,
      device: "0",
      inode: "256",
    }),
  ).rejects.toBe(refused);
});

it.runIf(Boolean(process.env.OPENCLAW_TEST_BTRFS_ROOT))(
  "diffs immutable native snapshots, detects hidden edits, and cleans retained snapshots across device changes",
  async ({ signal }) => {
    const root = await fs.mkdtemp(path.join(process.env.OPENCLAW_TEST_BTRFS_ROOT!, "checkpoint-"));
    const source = path.join(root, "source");
    const options = { signal, commitGuard: () => signal.throwIfAborted() };
    const snapshots: BtrfsCheckpoint[] = [];
    const commands = vi.spyOn(execRunner, "runCommandBuffersWithTimeout");
    const btrfs = async (...args: string[]) => {
      const result = await execRunner.runCommandBuffersWithTimeout(["btrfs", ...args], {
        timeoutMs: 30_000,
      });
      expect(result.code, result.stderr.toString()).toBe(0);
    };
    try {
      await btrfs("subvolume", "create", source);
      await fs.mkdir(path.join(source, "nested"));
      const filename = path.join(source, "nested", "source.txt");
      await fs.writeFile(filename, "original\n");
      const sourceIdentity = await readBtrfsCheckpointIdentity(source, options);
      if (!sourceIdentity) {
        throw new Error("Btrfs source identity is required by this native fixture");
      }
      commands.mockClear();
      const checkpoint = async (name: string) => {
        const pathname = path.join(root, name);
        const created = await createBtrfsCheckpoint(source, pathname, options, sourceIdentity);
        expect(created).not.toBeNull();
        if (!created) {
          throw new Error("Btrfs checkpoint support is required by this native fixture");
        }
        const result = { path: pathname, identity: created };
        snapshots.push(result);
        return result;
      };
      const before = await checkpoint("before");
      const unchanged = await checkpoint("unchanged");
      expect(await diffBtrfsCheckpoints(before, unchanged, options)).toEqual(new Set());
      // Two captures (four commands each) and one diff (send plus two final shows).
      expect(commands).toHaveBeenCalledTimes(11);
      const originalStat = await fs.stat(filename);
      await fs.writeFile(filename, "modified\n");
      await fs.utimes(filename, originalStat.atime, originalStat.mtime);
      const changed = await checkpoint("changed");
      expect(await diffBtrfsCheckpoints(unchanged, changed, options)).toEqual(new Set(["nested"]));
      expect(await fs.readFile(path.join(before.path, "nested/source.txt"), "utf8")).toBe(
        "original\n",
      );
      expect(await fs.readFile(path.join(changed.path, "nested/source.txt"), "utf8")).toBe(
        "modified\n",
      );
      expect(await deleteBtrfsCheckpoint(changed.path, before.identity, options)).toBe(false);
      expect(await fs.stat(changed.path)).toBeDefined();
      expect(
        await diffBtrfsCheckpoints(
          before,
          { ...changed, identity: { ...changed.identity, uuid: before.identity.uuid } },
          options,
        ),
      ).toBeNull();
      const alias = path.join(root, "alias");
      await fs.symlink(changed.path, alias);
      expect(await diffBtrfsCheckpoints(before, { ...changed, path: alias }, options)).toBeNull();
      await fs.unlink(alias);
      const priorMount = {
        ...unchanged,
        identity: { ...unchanged.identity, device: String(BigInt(unchanged.identity.device) + 1n) },
      };
      expect(await diffBtrfsCheckpoints(before, priorMount, options)).toBeNull();
      expect(await deleteBtrfsCheckpoint(priorMount.path, priorMount.identity, options)).toBe(true);
      await expect(fs.lstat(priorMount.path)).rejects.toMatchObject({ code: "ENOENT" });
      const hidden = path.join(source, ".env.local");
      await fs.writeFile(hidden, "hidden original\n");
      await fs.link(hidden, path.join(source, "source.txt"));
      const linkedBefore = await checkpoint("linked-before");
      await fs.writeFile(hidden, "hidden modified\n");
      const linkedChanged = await checkpoint("linked-changed");
      expect(await diffBtrfsCheckpoints(linkedBefore, linkedChanged, options)).toBeNull();
      expect(await fs.readFile(path.join(linkedChanged.path, "source.txt"), "utf8")).toBe(
        "hidden modified\n",
      );
      await btrfs("subvolume", "create", path.join(source, "nested-subvolume"));
      expect(
        await createBtrfsCheckpoint(
          source,
          path.join(root, "unsupported"),
          options,
          sourceIdentity,
        ),
      ).toBeNull();
      await btrfs("subvolume", "delete", path.join(source, "nested-subvolume"));
    } finally {
      commands.mockRestore();
      for (const snapshot of snapshots.toReversed()) {
        expect(
          await deleteBtrfsCheckpoint(snapshot.path, snapshot.identity, { commitGuard() {} }),
        ).toBe(true);
      }
      await btrfs("subvolume", "delete", source);
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
