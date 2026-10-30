import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { localWorkspaceDigestBytes } from "./local-workspace-cas.js";
import type {
  LocalWorkspaceMutation,
  LocalWorkspaceProjection,
} from "./local-workspace-store.types.js";
import type { LocalWorkspaceOwner } from "./local-workspace-types.js";

/** Initial reconciliation state is published as one owner-bound row. */
export function createLocalWorkspaceProjectionRow(
  owner: LocalWorkspaceOwner,
  projectionPath: string,
  baseCommit: string,
  sourcePaths: string,
): Omit<LocalWorkspaceProjection, "revision"> {
  return {
    worktree_id: owner.worktree.id,
    agent_id: owner.agentId,
    session_key: owner.sessionKey,
    session_id: owner.sessionId,
    lifecycle_revision: owner.lifecycleRevision,
    projection_path: projectionPath,
    base_commit: baseCommit,
    source_paths_json: sourcePaths,
    baseline_json: null,
    baseline_ref: null,
    tree_root_digest: null,
    source_paths_digest: null,
    canonical_fingerprints: null,
    projection_fingerprints: null,
    filesystem_checkpoints_json: null,
    checkpoint_json: null,
    pending_ref: null,
    pending_target: null,
    journal_json: null,
    journal_pack: null,
    paused_runtimes_json: null,
    created_at_ms: Date.now(),
  };
}

function freezeProjection(row: LocalWorkspaceProjection): LocalWorkspaceProjection {
  const pack = row.journal_pack;
  if (Buffer.isBuffer(pack)) {
    // Worker/database rows expose plain byte views, without Node Buffer's JSON behavior.
    row.journal_pack = new Uint8Array(pack.buffer, pack.byteOffset, pack.byteLength);
  }
  return Object.freeze(row);
}

/** Reconstruct only the admitted mutation; caller-provided prior rows carry no authority. */
export function readLocalWorkspaceCommit(
  value: unknown,
  id: string,
  mutation: LocalWorkspaceMutation,
  previous: LocalWorkspaceProjection | undefined,
): LocalWorkspaceProjection | undefined {
  if (value === undefined) {
    throw new Error("Local workspace commit coverage is incomplete");
  }
  if (mutation.kind === "delete" && value === null) {
    return undefined;
  }
  if (isRecord(value) && value.worktree_id === id) {
    if (mutation.kind === "create" && value.revision === 0) {
      return freezeProjection({ ...mutation.row, revision: 0 });
    }
    if (
      mutation.kind === "update" &&
      previous?.worktree_id === id &&
      previous.revision === mutation.revision &&
      value.revision === mutation.revision + 1
    ) {
      return freezeProjection({
        ...previous,
        ...Object.fromEntries(
          Object.entries(mutation.patch).filter(([, entry]) => entry !== undefined),
        ),
        ...(mutation.manifest
          ? {
              baseline_ref: mutation.manifest.resultingRoot,
              baseline_json: null,
              ...(mutation.manifest.treeRoot
                ? { tree_root_digest: localWorkspaceDigestBytes(mutation.manifest.treeRoot) }
                : {}),
              ...(mutation.manifest.fingerprints
                ? {
                    [`${mutation.manifest.fingerprints.target}_fingerprints`]: Uint8Array.from(
                      Buffer.from(mutation.manifest.fingerprints.blob, "base64"),
                    ),
                  }
                : {}),
            }
          : {}),
        worktree_id: id,
        revision: mutation.revision + 1,
      });
    }
  }
  throw new Error("Local workspace commit identity is invalid");
}
