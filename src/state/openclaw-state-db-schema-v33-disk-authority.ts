import type { DatabaseSync } from "node:sqlite";
import { ensureColumn } from "./openclaw-state-db-schema-helpers.js";

export const stateDiskAuthorityMigration = {
  version: 33,
  tables: ["session_repository_workspaces", "worker_workspace_pending_results"],
  columns: [
    "session_repository_workspaces.disk_authority_json",
    "worker_workspace_pending_results.disk_authority_json",
  ],
  migrate(db: DatabaseSync, previousVersion: number) {
    if (previousVersion >= 33) {
      return false;
    }
    const workspace = ensureColumn(db, "session_repository_workspaces", "disk_authority_json TEXT");
    return (
      ensureColumn(db, "worker_workspace_pending_results", "disk_authority_json TEXT") || workspace
    );
  },
  applied: "Recorded authoritative retained workspace disks and result custody (v33)",
};

export function withLegacyDiskAuthority(schema: string): string {
  return schema.replace(/\n {2}"?disk_authority_json"?[^\n]*,(?=\n)/gu, "");
}
