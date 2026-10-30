import fs from "node:fs/promises";
import path from "node:path";
import { decodeMountInfoPath } from "@openclaw/normalization-core/mountinfo-path";
import { hasNodeErrorCode } from "../../infra/path-guards.js";
import { runCommandBuffersWithTimeout } from "../../process/exec-runner.js";
import type { WorktreeFilesystemOptions } from "./filesystem-backend.types.js";
import {
  MAX_BTRFS_CHECKPOINT_STREAM_BYTES,
  parseBtrfsCheckpointChanges,
} from "./filesystem-btrfs-stream.js";

export type BtrfsCheckpointIdentity = {
  uuid: string;
  parentUuid: string | null;
  device: string;
  inode: string;
};
export type BtrfsCheckpoint = { path: string; identity: BtrfsCheckpointIdentity };

function assertCurrent(options: WorktreeFilesystemOptions): void {
  options.signal?.throwIfAborted();
  options.commitGuard();
}

async function command(
  args: string[],
  options: WorktreeFilesystemOptions,
  maxOutputBytes = 64 * 1024,
): Promise<Buffer | null> {
  assertCurrent(options);
  try {
    const result = await runCommandBuffersWithTimeout(
      [
        "/bin/sh",
        "-c",
        'IFS= read -r checkpoint_admission && test "$checkpoint_admission" = ready && exec "$@"',
        "openclaw-btrfs",
        "btrfs",
        ...args,
      ],
      {
        // Broker launch can yield. The shell cannot touch the filesystem until
        // this owner revalidates and releases its stdin admission.
        input: "ready\n",
        beforeInput: () => assertCurrent(options),
        timeoutMs: 30_000,
        signal: options.signal,
        env: { LC_ALL: "C" },
        maxOutputBytes: { stdout: maxOutputBytes, stderr: 16 * 1024 },
        terminateOnOutputLimit: { stdout: true, stderr: true },
        killProcessTree: true,
        requireProcessTreeExtinction: true,
      },
    );
    assertCurrent(options);
    return result.code === 0 && result.termination === "exit" ? result.stdout : null;
  } catch {
    assertCurrent(options);
    return null;
  }
}

function sameStableIdentity(
  left: BtrfsCheckpointIdentity,
  right: BtrfsCheckpointIdentity,
): boolean {
  return (
    left.uuid === right.uuid && left.parentUuid === right.parentUuid && left.inode === right.inode
  );
}

function sameIdentity(left: BtrfsCheckpointIdentity, right: BtrfsCheckpointIdentity): boolean {
  return sameStableIdentity(left, right) && left.device === right.device;
}

async function matchesCheckpointPath(
  root: string,
  expected: BtrfsCheckpointIdentity,
  options: WorktreeFilesystemOptions,
): Promise<boolean> {
  assertCurrent(options);
  if (process.platform !== "linux" || !path.isAbsolute(root)) {
    return false;
  }
  try {
    const stats = await fs.lstat(root, { bigint: true });
    const matches =
      stats.isDirectory() &&
      String(stats.ino) === expected.inode &&
      String(stats.dev) === expected.device &&
      (await fs.realpath(root)) === root;
    assertCurrent(options);
    return matches;
  } catch {
    assertCurrent(options);
    return false;
  }
}

/** UUID identifies a subvolume; transaction generations do not identify its contents. */
export async function readBtrfsCheckpointIdentity(
  root: string,
  options: WorktreeFilesystemOptions,
  readOnly = false,
): Promise<BtrfsCheckpointIdentity | null> {
  assertCurrent(options);
  if (process.platform !== "linux" || !path.isAbsolute(root)) {
    return null;
  }
  try {
    const stats = await fs.lstat(root, { bigint: true });
    if (
      !stats.isDirectory() ||
      stats.ino !== 256n ||
      (await fs.realpath(root)) !== root ||
      (await fs.statfs(root, { bigint: true })).type !== 0x9123683en
    ) {
      return null;
    }
    const raw = await command(["subvolume", "show", root], options);
    if (!raw) {
      return null;
    }
    const output = raw.toString("utf8");
    const values = (label: string) => [
      ...output.matchAll(new RegExp(`^\\s*${label}:\\s*([^\\r\\n]+)$`, "gm")),
    ];
    const identities = values("UUID");
    const parents = values("Parent UUID");
    const flags = values("Flags");
    const uuid = identities[0]?.[1]?.trim();
    const parent = parents[0]?.[1]?.trim();
    const validUuid = (value: string | undefined) =>
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value ?? "");
    if (
      identities.length !== 1 ||
      parents.length !== 1 ||
      !validUuid(uuid) ||
      !(parent === "-" || validUuid(parent)) ||
      (readOnly && (flags.length !== 1 || flags[0]![1]!.trim() !== "readonly"))
    ) {
      return null;
    }
    assertCurrent(options);
    return {
      uuid: uuid!,
      parentUuid: parent === "-" ? null : parent!,
      device: String(stats.dev),
      inode: String(stats.ino),
    };
  } catch {
    assertCurrent(options);
    return null;
  }
}

/** The caller supplies the source identity recorded by its durable destination reservation. */
export async function createBtrfsCheckpoint(
  source: string,
  destination: string,
  options: WorktreeFilesystemOptions,
  sourceIdentity: BtrfsCheckpointIdentity,
): Promise<BtrfsCheckpointIdentity | null> {
  if (!(await matchesCheckpointPath(source, sourceIdentity, options))) {
    return null;
  }
  const mountInfo = await fs.readFile("/proc/self/mountinfo", "utf8").catch(() => null);
  assertCurrent(options);
  if (
    mountInfo === null ||
    mountInfo.split("\n").some((line) => {
      const mountPoint = line.split(" ")[4];
      return mountPoint !== undefined && decodeMountInfoPath(mountPoint).startsWith(`${source}/`);
    })
  ) {
    return null;
  }
  // A snapshot omits nested subvolume contents. Such workspaces retain full scanning.
  const descendants = await command(["subvolume", "list", "-o", source], options);
  if (descendants === null || descendants.length !== 0) {
    return null;
  }
  assertCurrent(options);
  if ((await command(["subvolume", "snapshot", "-r", source, destination], options)) === null) {
    return null;
  }
  const created = await readBtrfsCheckpointIdentity(destination, options, true);
  const retainedSource = await readBtrfsCheckpointIdentity(source, options);
  return created &&
    created.parentUuid === sourceIdentity.uuid &&
    retainedSource &&
    sameIdentity(retainedSource, sourceIdentity)
    ? created
    : null;
}

/** Missing, replaced, unsupported or incomplete snapshots require the owner's full scan. */
export async function diffBtrfsCheckpoints(
  parent: BtrfsCheckpoint,
  current: BtrfsCheckpoint,
  options: WorktreeFilesystemOptions,
): Promise<ReadonlySet<string> | null> {
  for (const snapshot of [parent, current]) {
    if (!(await matchesCheckpointPath(snapshot.path, snapshot.identity, options))) {
      return null;
    }
  }
  // Send requires readonly roots; the stream and post-send inspection verify
  // UUIDs and retained readonly custody before any manifest reads.
  const stream = await command(
    ["send", "--no-data", "--proto", "1", "-p", parent.path, current.path],
    options,
    MAX_BTRFS_CHECKPOINT_STREAM_BYTES,
  );
  if (!stream) {
    return null;
  }
  for (const snapshot of [parent, current]) {
    const identity = await readBtrfsCheckpointIdentity(snapshot.path, options, true);
    if (!identity || !sameIdentity(identity, snapshot.identity)) {
      return null;
    }
  }
  const changes = parseBtrfsCheckpointChanges(stream, {
    snapshotUuid: current.identity.uuid,
    parentUuid: parent.identity.uuid,
  });
  if (!changes) {
    return null;
  }
  // Send can describe an inode write through just one hardlink, including an
  // ignored path. Inspect aliases before the manifest owner filters roots.
  for (const relative of changes.paths) {
    const filename = path.join(current.path, relative);
    try {
      const resolved = await fs.realpath(filename);
      assertCurrent(options);
      if (!resolved.startsWith(`${current.path}/`)) {
        return null;
      }
      const stats = await fs.lstat(filename);
      assertCurrent(options);
      if (stats.isFile() && stats.nlink > 1) {
        return null;
      }
    } catch (error) {
      assertCurrent(options);
      if (!hasNodeErrorCode(error, "ENOENT") && !hasNodeErrorCode(error, "ENOTDIR")) {
        return null;
      }
    }
  }
  return changes.roots;
}

/** Never remove a replaced directory or a writable workspace as checkpoint cleanup. */
export async function deleteBtrfsCheckpoint(
  root: string,
  expected: BtrfsCheckpointIdentity,
  options: WorktreeFilesystemOptions,
): Promise<boolean> {
  assertCurrent(options);
  const existing = await fs.lstat(root).catch((error: unknown) => {
    if (hasNodeErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  });
  assertCurrent(options);
  if (!existing) {
    return true;
  }
  const identity = await readBtrfsCheckpointIdentity(root, options, true);
  // st_dev can change after remount; the retained snapshot UUID still owns cleanup.
  if (!identity || !sameStableIdentity(identity, expected)) {
    return false;
  }
  assertCurrent(options);
  return (await command(["subvolume", "delete", root], options)) !== null;
}
