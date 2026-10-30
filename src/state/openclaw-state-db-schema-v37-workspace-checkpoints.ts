import type { DatabaseSync } from "node:sqlite";
import { ensureColumn, tableExists } from "./openclaw-state-db-schema-helpers.js";

/** Existing projections begin without a filesystem checkpoint and take a full scan. */
function migrateLocalWorkspaceCheckpoints(db: DatabaseSync, previousVersion: number): boolean {
  if (previousVersion >= 37 || !tableExists(db, "local_workspace_projections")) {
    return false;
  }
  ensureColumn(db, "local_workspace_projections", "filesystem_checkpoints_json TEXT");
  return true;
}

export const stateLocalWorkspaceCheckpointsMigration = {
  version: 37,
  tables: ["local_workspace_projections"],
  columns: ["local_workspace_projections.filesystem_checkpoints_json"],
  migrate: migrateLocalWorkspaceCheckpoints,
  applied: "Prepared durable local workspace filesystem checkpoints (v37)",
};

/** Exact predecessor DDL for schema admission, backups and engine ports. */
export function withLegacyLocalWorkspaceCheckpoints(schema: string): string {
  return schema.replace(
    /\n {2}"?filesystem_checkpoints_json"? (?:TEXT|text)(?: COLLATE "C")?,/gu,
    "",
  );
}

export const WORKSPACE_CHECKPOINTS_POSTGRES_MIGRATION_SQL = `DO $workspace_checkpoints_v37$
BEGIN
  IF to_regclass('local_workspace_projections') IS NOT NULL THEN
    ALTER TABLE local_workspace_projections ADD COLUMN filesystem_checkpoints_json text COLLATE "C";
  END IF;
END $workspace_checkpoints_v37$;`;
