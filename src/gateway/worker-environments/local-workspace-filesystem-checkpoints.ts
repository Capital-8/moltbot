import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  createBtrfsCheckpoint,
  deleteBtrfsCheckpoint,
  diffBtrfsCheckpoints,
  readBtrfsCheckpointIdentity,
} from "../../agents/worktrees/filesystem-btrfs-checkpoints.js";
import { hasNodeErrorCode } from "../../infra/path-guards.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { assertLocalWorkspaceDirectory } from "./local-workspace-checkout.js";

type Direction = "canonical" | "projection";
// Btrfs identifiers do not constrain the RFC UUID version or variant bits.
const btrfsIdentity = z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u);
const identity = z.object({
  uuid: btrfsIdentity,
  parentUuid: btrfsIdentity.nullable(),
  device: z.string().regex(/^\d+$/u),
  inode: z.string().regex(/^\d+$/u),
});
const reservation = z.object({ token: z.string().uuid(), source: identity });
const retained = reservation.extend({ snapshot: identity });
const accepted = retained.extend({
  baselineRef: z.string(),
  admissionRef: z.string(),
  runtimeId: z.string().uuid(),
});
const stateSchema = z.object({
  version: z.literal(1),
  accepted: z.object({ canonical: accepted.optional(), projection: accepted.optional() }),
  pending: reservation.extend({ target: z.enum(["canonical", "projection"]) }).optional(),
  garbage: z.array(reservation.extend({ snapshot: identity.optional() })).max(4),
});
type Checkpoints = z.infer<typeof stateSchema>;
type Reservation = z.infer<typeof reservation>;
type Retained = z.infer<typeof retained>;

export type PreparedLocalWorkspaceFilesystemCheckpoint = Retained & {
  target: Direction;
  root: string;
  previousRoot?: string;
  admissionRef?: string;
  changedRoots?: string[];
};

const log = createSubsystemLogger("agents/worktrees");
// A new runtime reestablishes its inventory policy with a full scan. Persisted
// snapshots remain cleanup receipts, never evidence for code from another build.
const runtimeId = randomUUID();

/** Snapshot files are derived data; the existing reconciliation row owns every reservation. */
export function localWorkspaceFilesystemCheckpoints(params: {
  projectionPath: string;
  current: () => { filesystem_checkpoints_json: string | null; baseline_ref: string | null };
  update: (patch: { filesystem_checkpoints_json: string | null }) => Promise<void>;
  assertCurrent: () => void;
  signal: AbortSignal;
}) {
  const directory = path.join(path.dirname(params.projectionPath), "checkpoints");
  const options = { commitGuard: params.assertCurrent, signal: params.signal };
  const location = (entry: Reservation) => path.join(directory, entry.token);
  const read = (): Checkpoints | undefined => {
    const raw = params.current().filesystem_checkpoints_json;
    if (!raw) {
      return { version: 1, accepted: {}, garbage: [] };
    }
    try {
      return stateSchema.parse(JSON.parse(raw));
    } catch {
      // Never derive deletion paths or reuse facts from a malformed retained receipt.
      log.warn("Invalid workspace filesystem checkpoint receipt; using full synchronization");
      return undefined;
    }
  };
  const write = (state: Checkpoints) =>
    params.update({ filesystem_checkpoints_json: JSON.stringify(state) });
  const clean = async (state: Checkpoints) => {
    if (!state.garbage.length) {
      return true;
    }
    const remaining: Checkpoints["garbage"] = [];
    for (const entry of state.garbage) {
      // A crash can precede the snapshot's reply. Its reservation still names
      // only this private path; parent UUID binds any completed snapshot to it.
      const snapshot =
        entry.snapshot ?? (await readBtrfsCheckpointIdentity(location(entry), options, true));
      params.assertCurrent();
      const exists =
        snapshot ||
        (await fs.lstat(location(entry)).catch((error: unknown) => {
          if (hasNodeErrorCode(error, "ENOENT")) {
            return undefined;
          }
          throw error;
        }));
      if ((!snapshot && exists) || (snapshot && snapshot.parentUuid !== entry.source.uuid)) {
        remaining.push(entry);
      } else if (snapshot && !(await deleteBtrfsCheckpoint(location(entry), snapshot, options))) {
        remaining.push(entry);
      }
    }
    state.garbage = remaining;
    await write(state);
    if (remaining.length) {
      log.warn("Workspace filesystem checkpoint cleanup deferred; using full synchronization");
    }
    return remaining.length === 0;
  };
  const discard = async (state: Checkpoints) => {
    state.garbage.push(...Object.values(state.accepted));
    state.accepted = {};
    if (state.pending) {
      state.garbage.push(state.pending);
      delete state.pending;
    }
    await write(state);
    return await clean(state);
  };
  return {
    async prepare(target: Direction, sourceRoot: string) {
      // Other platforms retain the existing scan without filesystem or SQLite work.
      if (process.platform !== "linux") {
        return undefined;
      }
      const state = read();
      if (!state) {
        return undefined;
      }
      if (
        state.pending ||
        Object.values(state.accepted).some((entry) => entry.runtimeId !== runtimeId)
      ) {
        // No accepted optimization survives an interrupted rotation. Settlement
        // uses its ordinary full scan; neither a file nor a generation is a commit.
        if (!(await discard(state))) {
          return undefined;
        }
      } else if (!(await clean(state))) {
        return undefined;
      }
      const source = await readBtrfsCheckpointIdentity(sourceRoot, options);
      if (!source) {
        return undefined;
      }
      params.assertCurrent();
      await assertLocalWorkspaceDirectory(path.dirname(directory));
      params.assertCurrent();
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await assertLocalWorkspaceDirectory(directory);
      params.assertCurrent();
      const pending = { target, token: randomUUID(), source };
      await write({ ...state, pending });
      const root = location(pending);
      const snapshot = await createBtrfsCheckpoint(sourceRoot, root, options);
      if (!snapshot || snapshot.parentUuid !== source.uuid) {
        // Retain cleanup custody if snapshot creation had an uncertain outcome.
        return undefined;
      }
      const previous = state.accepted[target];
      const matching =
        previous?.source.uuid === source.uuid &&
        previous.source.device === source.device &&
        previous.baselineRef === params.current().baseline_ref;
      const changed = matching
        ? await diffBtrfsCheckpoints(
            { path: location(previous), identity: previous.snapshot },
            { path: root, identity: snapshot },
            options,
          )
        : null;
      return {
        ...pending,
        root,
        snapshot,
        ...(matching
          ? { previousRoot: previous.baselineRef, admissionRef: previous.admissionRef }
          : {}),
        ...(changed ? { changedRoots: [...changed] } : {}),
      } satisfies PreparedLocalWorkspaceFilesystemCheckpoint;
    },
    async accept(
      prepared: PreparedLocalWorkspaceFilesystemCheckpoint,
      baselineRef: string,
      admissionRef: string,
    ) {
      const state = read();
      if (
        !state ||
        state.pending?.token !== prepared.token ||
        params.current().baseline_ref !== baselineRef
      ) {
        throw new Error("Workspace filesystem checkpoint acceptance changed");
      }
      const previous = state.accepted[prepared.target];
      if (previous) {
        state.garbage.push(previous);
      }
      state.accepted[prepared.target] = {
        token: prepared.token,
        source: prepared.source,
        snapshot: prepared.snapshot,
        baselineRef,
        admissionRef,
        runtimeId,
      };
      delete state.pending;
      // Filesystem cleanup follows durable acceptance; a crash retains its identities.
      await write(state);
      await clean(state);
    },
    async remove() {
      if (!params.current().filesystem_checkpoints_json) {
        return;
      }
      const state = read();
      if (!state || !(await discard(state))) {
        throw new Error("Workspace filesystem checkpoints need cleanup before expiry");
      }
      await params.update({ filesystem_checkpoints_json: null });
    },
  };
}
