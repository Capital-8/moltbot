import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readWorkerPreparation } from "../gateway/worker-environments/preparation-identity.schema.js";
import { extractSqliteTableSchema, quoteSqliteIdentifier } from "../infra/sqlite-schema-sql.js";
import { tableExists, tableHasColumn } from "./openclaw-state-db-schema-helpers.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

export function hasHistoricalImageReserveSnapshots(db: DatabaseSync): boolean {
  return (
    tableExists(db, "worker_environments") &&
    Boolean(
      db
        .prepare(`SELECT 1
    FROM worker_environments WHERE json_valid(profile_snapshot_json)
      AND json_extract(profile_snapshot_json, '$.project.kind') = 'image' LIMIT 1`)
        .get(),
    )
  );
}

/** Doctor owns this data cutover even when an earlier import already published schema 22. */
export function migrateHistoricalImageReserveSnapshots(db: DatabaseSync): boolean {
  if (!hasHistoricalImageReserveSnapshots(db)) {
    return false;
  }
  const rows = db
    .prepare(`SELECT environment_id, profile_snapshot_json FROM worker_environments
    WHERE json_valid(profile_snapshot_json)
      AND json_extract(profile_snapshot_json, '$.project.kind') = 'image'`)
    .all();
  const update = db.prepare(
    "UPDATE worker_environments SET profile_snapshot_json = ? WHERE environment_id = ?",
  );
  for (const row of rows) {
    if (typeof row.profile_snapshot_json !== "string" || typeof row.environment_id !== "string") {
      throw new Error("Historical image reserve row is invalid");
    }
    const profile: unknown = JSON.parse(row.profile_snapshot_json);
    const project = isRecord(profile) ? profile.project : undefined;
    if (
      !isRecord(profile) ||
      !isRecord(project) ||
      project.kind !== "image" ||
      typeof project.key !== "string" ||
      !/^[a-f0-9]{64}$/u.test(project.key) ||
      !isRecord(project.preparation) ||
      profile.runtimePreparation !== undefined ||
      profile.historicalProfileSnapshotJson !== undefined
    ) {
      throw new Error("Historical image reserve snapshot has conflicting or invalid preparation");
    }
    profile.runtimePreparation = { ...project.preparation, source: "image" };
    delete profile.project;
    readWorkerPreparation(profile);
    // Retain original serialized evidence, including the retired image-project key.
    // The current profile owners never consume this archive as preparation authority.
    profile.historicalProfileSnapshotJson = row.profile_snapshot_json;
    // sqlite-allow-raw -- Offline structural migration; all custody/deadline columns stay untouched.
    update.run(JSON.stringify(profile), row.environment_id);
  }
  return true;
}

/** The enclosing schema transaction owns foreign-key suspension and final validation. */
export function migrateHistoricalRepositoryPreparation(
  db: DatabaseSync,
  previousVersion: number,
): boolean {
  if (
    previousVersion !== 21 ||
    !tableHasColumn(db, "worker_session_placements", "repository_preparation")
  ) {
    return false;
  }
  // Never retire an unsettled worker claim just to make its row fit today's schema.
  const claimed = db
    .prepare(`SELECT 1 FROM worker_session_placements
    WHERE repository_preparation IN ('pending', 'failed') AND turn_claim_owner = 'worker'
    LIMIT 1`)
    .get();
  if (claimed) {
    throw new Error(
      "Historical repository preparation retains a worker turn claim; reconcile its owned cleanup before migrating.",
    );
  }
  const table = "worker_session_placements";
  const temporary = `${table}_historical_migration`;
  const schema = extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, table);
  const columns = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => {
      if (typeof row.name !== "string") {
        throw new Error("Historical worker placement column is invalid");
      }
      return row.name;
    });
  const objects = db
    .prepare(`SELECT sql FROM sqlite_schema
    WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL`)
    .all(table);
  db.exec(schema.replace(`CREATE TABLE IF NOT EXISTS ${table}`, `CREATE TABLE ${temporary}`));
  // Keep every recorded identity, lease/owner/generation, workspace fact and claim.
  // The old preparation value remains diagnostic data, never runnable authority.
  const select = columns
    .map((column) => {
      if (column === "state") {
        return "CASE WHEN repository_preparation IN ('pending', 'failed') THEN 'failed' ELSE state END";
      }
      if (column === "recovery_error") {
        return `CASE WHEN repository_preparation IN ('pending', 'failed')
        THEN 'Historical repository preparation ' || repository_preparation ||
          ' (previous placement ' || state || '); owned cleanup required before recovery.' ||
          CASE WHEN recovery_error IS NULL THEN '' ELSE ' ' || recovery_error END
        ELSE recovery_error END`;
      }
      if (column === "terminal_at_ms") {
        return `CASE WHEN repository_preparation IN ('pending', 'failed')
        THEN coalesce(terminal_at_ms, ${Date.now()}) ELSE terminal_at_ms END`;
      }
      return quoteSqliteIdentifier(column);
    })
    .join(", ");
  // sqlite-allow-raw -- Transactional canonical table cutover preserving historical custody.
  db.exec(`INSERT INTO ${temporary} (${columns.map(quoteSqliteIdentifier).join(", ")})
    SELECT ${select} FROM ${table};
    DROP TABLE ${table};
    ALTER TABLE ${temporary} RENAME TO ${table};`);
  for (const object of objects) {
    if (typeof object.sql !== "string") {
      throw new Error("Historical worker placement schema object is invalid");
    }
    // sqlite-allow-raw -- Replay existing local indexes/triggers after the atomic rebuild.
    db.exec(object.sql);
  }
  return true;
}
