import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readWorkerPreparation } from "../gateway/worker-environments/preparation-identity.schema.js";
import {
  original,
  preparation,
  stateV22Schema,
} from "./openclaw-historical-imports.test-support.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { ensureSecretStoreSchema } from "./openclaw-state-db-schema-additive.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  prepareOpenClawStateDatabaseSchema,
  repairOpenClawStateDatabaseSchema,
} from "./openclaw-state-db.js";
import { withStateMigrationBackupForTest } from "./openclaw-state-schema.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(closeOpenClawStateDatabaseAsync);
function seed(db: DatabaseSync, id: string, snapshot = original) {
  db.prepare(
    "INSERT INTO worker_environments " +
      "(environment_id,provider_id,profile_id,profile_snapshot_json,provision_operation_id,lease_id," +
      "preparation_key,preparation_purpose,preparation_demand_at_ms,preparation_expires_at_ms," +
      "preparation_consumed_at_ms,state,owner_epoch,attached_session_ids_json," +
      "created_at_ms,updated_at_ms,state_changed_at_ms,destroy_requested_at_ms) " +
      "VALUES (?, 'synthetic','profile',?,?,?,?,'reserve',1000,2000,1500,'destroyed',7,'[]',1,2,2,2)",
  ).run(id, snapshot, id, "lease-" + id, preparation.key);
}

it("rolls back the version phase on malformed image evidence and retries without losing rows", async () => {
  const env = { OPENCLAW_STATE_DIR: dirs.make("historical-image-rollback-") };
  const pathname = path.join(env.OPENCLAW_STATE_DIR, "state", "openclaw.sqlite");
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  const options = { env, path: pathname, versionMigrationOnly: true };
  {
    using db = new DatabaseSync(pathname);
    db.exec(stateV22Schema());
    db.exec(
      "PRAGMA user_version=22; INSERT INTO schema_meta(meta_key,role,schema_version,created_at,updated_at) VALUES ('primary','global',22,1,1);",
    );
    seed(db, "valid");
    seed(
      db,
      "invalid",
      JSON.stringify({ project: { kind: "image", key: "b".repeat(64), preparation: {} } }),
    );
  }
  await withStateMigrationBackupForTest(options, () => {
    using before = new DatabaseSync(pathname, { readOnly: true });
    const rows = before.prepare("SELECT * FROM worker_environments ORDER BY environment_id").all();
    before.close();
    expect(repairOpenClawStateDatabaseSchema(options).warnings.join("\n")).toContain(
      "Worker runtime preparation identity is invalid",
    );
    using failed = new DatabaseSync(pathname);
    expect(failed.prepare("PRAGMA user_version").get()?.user_version).toBe(22);
    expect(failed.prepare("SELECT schema_version FROM schema_meta").get()?.schema_version).toBe(22);
    expect(
      failed.prepare("SELECT * FROM worker_environments ORDER BY environment_id").all(),
    ).toEqual(rows);
    failed
      .prepare(
        "UPDATE worker_environments SET profile_snapshot_json = ? WHERE environment_id = 'invalid'",
      )
      .run(original);
    failed.close();
    expect(repairOpenClawStateDatabaseSchema(options).warnings).toEqual([]);
    using migrated = new DatabaseSync(pathname, { readOnly: true });
    expect(migrated.prepare("PRAGMA user_version").get()?.user_version).toBe(
      OPENCLAW_STATE_SCHEMA_VERSION,
    );
    const profiles = migrated
      .prepare("SELECT profile_snapshot_json FROM worker_environments")
      .all();
    expect(profiles).toHaveLength(2);
    for (const row of profiles) {
      const profile = JSON.parse(String(row.profile_snapshot_json));
      expect(readWorkerPreparation(profile)).toEqual({ ...preparation, source: "empty" });
      expect(profile.historicalProfileSnapshotJson).toBe(original);
    }
  });
});

it.each([
  ["Doctor repairs an image snapshot even when a prior import advanced the version", "current"],
  ["automatic retains historical image evidence alongside a present lazy-column gap", "automatic"],
  [
    "doctor-preparation retains historical image evidence alongside a present lazy-column gap",
    "doctor",
  ],
] as const)("%s", async (_name, admission) => {
  const env = { OPENCLAW_STATE_DIR: dirs.make("historical-image-admission-") };
  const pathname =
    admission === "current"
      ? openOpenClawStateDatabase({ env }).path
      : path.join(env.OPENCLAW_STATE_DIR, "state", "openclaw.sqlite");
  await closeOpenClawStateDatabaseAsync();
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  let before: Record<string, SQLOutputValue>;
  {
    using db = new DatabaseSync(pathname);
    if (admission !== "current") {
      db.exec(stateV22Schema());
      db.exec(
        "PRAGMA user_version=22; INSERT INTO schema_meta(meta_key,role,schema_version,created_at,updated_at) VALUES ('primary','global',22,1,1);",
      );
      ensureSecretStoreSchema(db);
      db.exec("ALTER TABLE secret_store_entries DROP COLUMN allowed_hosts");
    }
    seed(db, "retained");
    before = db.prepare("SELECT * FROM worker_environments").get()!;
  }
  await withStateMigrationBackupForTest({ env }, async () => {
    if (admission === "automatic") {
      openOpenClawStateDatabase({ env });
    } else {
      expect(
        (await prepareOpenClawStateDatabaseSchema({ env }, "doctor-preparation")).warnings,
      ).toEqual([]);
    }
    await closeOpenClawStateDatabaseAsync();
    using db = new DatabaseSync(pathname, { readOnly: true });
    const after = db.prepare("SELECT * FROM worker_environments").get()!;
    const profile = JSON.parse(String(after.profile_snapshot_json));
    expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(
      OPENCLAW_STATE_SCHEMA_VERSION,
    );
    expect(after).toEqual({ ...before, profile_snapshot_json: expect.any(String) });
    expect(profile).toEqual({
      install: "bundle",
      settings: { provider: "synthetic" },
      runtimePreparation: { ...preparation, source: "empty" },
      historicalProfileSnapshotJson: original,
    });
    expect(readWorkerPreparation(profile)).toEqual({ ...preparation, source: "empty" });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
