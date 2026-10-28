import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { captureFreshDoctorMigrationTables } from "../commands/doctor-migration-backup.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { runWithDoctorMigrationBackup } from "../infra/update-doctor-migration-attribution.js";
import { createOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { migrateHistoricalRepositoryPreparation } from "./openclaw-state-db-teamclaw-migration.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";
import { ensureProfileForEmail } from "./user-profiles.js";

const historical = fs.readFileSync(
  new URL("./openclaw-state-teamclaw-placement.test-fixture.sql", import.meta.url),
  "utf8",
);
const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(closeOpenClawStateDatabaseAsync);

function seedPlacements(db: DatabaseSync) {
  db.exec(historical);
  const insert = db.prepare(`INSERT INTO worker_session_placements
    (session_id, agent_id, session_key, execution_mode, state, environment_id,
     transition_generation, active_owner_epoch, workspace_base_manifest_ref,
     repository_preparation, remote_workspace_dir, worker_bundle_hash,
     created_at_ms, updated_at_ms, state_changed_at_ms, terminal_at_ms)
    VALUES (?, 'main', ?, 'worker-turn', ?, 'environment-1', 7, 3, ?, ?, '/repo', 'bundle-1', 1, 2, 2, ?)`);
  insert.run("ready", "agent:main:ready", "reclaimed", "accepted-manifest", "ready", 2);
  insert.run("pending", "agent:main:pending", "active", null, "pending", null);
  insert.run("failed", "agent:main:failed", "draining", null, "failed", null);
}

it("Doctor preserves historical v21 records and fences incomplete repository preparation", async () => {
  const root = dirs.make("openclaw-teamclaw-migration-");
  const env = { OPENCLAW_STATE_DIR: root };
  const options = { path: resolveOpenClawStateSqlitePath(env), env };
  openOpenClawStateDatabase(options);
  const profile = ensureProfileForEmail("synthetic@example.test", options);
  await closeOpenClawStateDatabaseAsync();
  using seed = new DatabaseSync(options.path);
  seed.exec(OPENCLAW_STATE_SCHEMA_SQL);
  seed.exec("PRAGMA foreign_keys = OFF; DROP TABLE worker_session_placements;");
  seedPlacements(seed);
  seed.exec(`CREATE INDEX historical_placement_owner ON worker_session_placements(active_owner_epoch);
    PRAGMA user_version = 21; UPDATE schema_meta SET schema_version = 21;
    DROP INDEX idx_delivery_queue_bounded_retention;
    ALTER TABLE delivery_queue_entries DROP COLUMN retention_id_prefix;
    ALTER TABLE delivery_queue_entries DROP COLUMN retention_max_age_ms;
    ALTER TABLE delivery_queue_entries DROP COLUMN retention_max_entries;`);
  seed
    .prepare(`INSERT INTO user_profile_identities
    (provider, subject, profile_id, created_at, verified_email_json)
    VALUES ('github:microsoft.ghe.com', '101', ?, 1, ?)`)
    .run(profile.id, JSON.stringify({ email: "synthetic@example.test", profileId: profile.id }));
  const before = seed.prepare("SELECT * FROM worker_session_placements ORDER BY session_id").all();
  const identity = seed.prepare("SELECT * FROM user_profile_identities").all();
  seed.close();
  const maintenance = createOpenClawDatabaseMaintenanceScope({
    schemaMaintenance: true,
    assertOwnerCurrent() {},
    assertDatabaseAccess(databasePath) {
      expect(databasePath).toBe(options.path);
    },
  });
  try {
    await maintenance.run(() =>
      runWithDoctorMigrationBackup(captureFreshDoctorMigrationTables, async () => {
        expect(repairOpenClawStateDatabaseSchema(options).warnings).toEqual([]);
        const db = openOpenClawStateDatabase(options).db;
        expect(db.prepare("PRAGMA user_version").get()).toEqual({
          user_version: OPENCLAW_STATE_SCHEMA_VERSION,
        });
        expect(db.prepare("SELECT * FROM user_profile_identities").all()).toEqual(identity);
        const after = db
          .prepare("SELECT * FROM worker_session_placements ORDER BY session_id")
          .all();
        expect(after).toHaveLength(3);
        for (let i = 0; i < before.length; i++) {
          const original = before[i]!;
          const migrated = after[i]!;
          if (original.repository_preparation === "ready") {
            expect(migrated).toEqual({ ...original, confirmed_loss_recovery_json: null });
          } else {
            expect(migrated).toEqual({
              ...original,
              confirmed_loss_recovery_json: null,
              state: "failed",
              recovery_error: expect.stringContaining(String(original.repository_preparation)),
              terminal_at_ms: expect.any(Number),
            });
            expect(migrated.workspace_base_manifest_ref).toBeNull();
            expect(() =>
              db
                .prepare(
                  "UPDATE worker_session_placements SET state = 'active', recovery_error = NULL WHERE session_id = ?",
                )
                .run(String(original.session_id)),
            ).toThrow(/CHECK/);
          }
        }
        expect(
          db
            .prepare("SELECT name FROM sqlite_schema WHERE name = 'historical_placement_owner'")
            .get(),
        ).toBeDefined();
        expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(db.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
        await closeOpenClawStateDatabaseAsync();
        expect(repairOpenClawStateDatabaseSchema(options).warnings).toEqual([]);
        expect(
          openOpenClawStateDatabase(options)
            .db.prepare("SELECT * FROM worker_session_placements ORDER BY session_id")
            .all(),
        ).toEqual(after);
      }),
    );
  } finally {
    await maintenance.run(() => closeOpenClawStateDatabaseAsync());
    await maintenance.close();
  }
});

it("refuses and rolls back incomplete worker claims without discarding cleanup custody", () => {
  using db = new DatabaseSync(":memory:");
  seedPlacements(db);
  db.exec(`UPDATE worker_session_placements SET turn_claim_owner = 'worker', turn_claim_id = 'claim-1',
    turn_claim_run_id = 'run-1', turn_claim_generation = 7, turn_claim_owner_epoch = 3 WHERE session_id = 'pending';`);
  const before = db.prepare("SELECT * FROM worker_session_placements ORDER BY session_id").all();
  expect(() =>
    runSqliteImmediateTransactionSync(db, () => migrateHistoricalRepositoryPreparation(db, 21)),
  ).toThrow("retains a worker turn claim");
  expect(db.prepare("SELECT * FROM worker_session_placements ORDER BY session_id").all()).toEqual(
    before,
  );
});
