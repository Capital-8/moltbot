import type { DatabaseSync } from "node:sqlite";
import { ensureColumn } from "./openclaw-state-db-schema-helpers.js";

export const stateRetentionMigration = {
  version: 32,
  tables: ["worker_environments", "worker_session_placements", "session_repository_workspaces"],
  columns: [
    "worker_environments.session_retention_json",
    "worker_session_placements.repository_preparation",
    "worker_session_placements.confirmed_loss_recovery_json",
    "session_repository_workspaces.recovery_json",
  ],
  migrate: (db: DatabaseSync, previousVersion: number) => {
    if (previousVersion >= 32) {
      return false;
    }
    const retained = ensureColumn(db, "worker_environments", "session_retention_json TEXT");
    const preparation = ensureColumn(
      db,
      "worker_session_placements",
      "repository_preparation TEXT",
    );
    const loss = ensureColumn(db, "worker_session_placements", "confirmed_loss_recovery_json TEXT");
    return (
      ensureColumn(db, "session_repository_workspaces", "recovery_json TEXT") ||
      loss ||
      preparation ||
      retained
    );
  },
  applied: "Retained session-private disks and historical repository preparation evidence (v32)",
};

/** Main's earlier schemas never owned retained disks or imported preparation evidence. */
export function withLegacyWorkerRetention(schema: string): string {
  return schema
    .replace(
      /\n {2}(?:-- Historical import[^\n]*\n {2})?"?(?:repository_preparation|confirmed_loss_recovery_json|recovery_json)"?[^\n]*,(?=\n)/gu,
      "",
    )
    .replace(/,\n {2}"?session_retention_json"?[^\n]*/gu, (column) =>
      column.endsWith(",") ? "," : "",
    );
}
