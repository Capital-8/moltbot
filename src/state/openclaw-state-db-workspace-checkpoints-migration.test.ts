import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { restoreDoctorMigrationBackup } from "../commands/doctor-migration-backup-restore.js";
import { prepareDoctorDatabaseMigrations } from "../commands/doctor-schema-migrations.js";
import { withMaintenance } from "../commands/doctor-schema-migrations.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { detectOpenClawStateDatabaseSchemaMigrations } from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { resolveSchemaMigrationBackupTables } from "./schema-migration-backup-scope.js";
import { assertSqliteMigrationScopePreserved } from "./sqlite-migration-scope.test-support.js";

// Independent predecessor DDL; the candidate never constructs its own old schema.
const legacySchema = fs.readFileSync(
  new URL("../../test/fixtures/sqlite/openclaw-state-schema-v36.sql", import.meta.url),
  "utf8",
);

it.each([false, true])(
  "Doctor preserves schema-36 workspace state and rollback (unused owner: %s)",
  async (absent) => {
    expect(createHash("sha256").update(legacySchema).digest("hex")).toBe(
      "b2ec9b58da4e49ede387db0c7345fe2dcf3a2e228736ca92a5223fc8bf518a6b",
    );
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const pathname = resolveOpenClawStateSqlitePath(state.env);
      fs.mkdirSync(path.dirname(pathname), { recursive: true });
      using database = new DatabaseSync(pathname);
      database.exec(legacySchema);
      database.exec(`PRAGMA user_version = 36;
        INSERT INTO schema_meta VALUES ('primary', 'global', 36, NULL, 'frozen-v36', 100, 100);
        INSERT INTO config_machine_state VALUES ('state.schema.contentVersion', '36', 100);
        INSERT INTO config_machine_state VALUES ('unrelated.setting', 'retained', 100);`);
      if (absent) {
        database.exec(
          "DROP TABLE local_workspace_manifest_nodes; DROP TABLE local_workspace_projections;",
        );
      } else {
        database.exec(`INSERT INTO local_workspace_projections
          (worktree_id, agent_id, session_key, session_id, projection_path, base_commit,
           source_paths_json, baseline_json, baseline_ref, pending_ref, pending_target,
           revision, created_at_ms, checkpoint_json, canonical_fingerprints, projection_fingerprints)
          VALUES ('worktree', 'main', 'session-key', 'session', '/synthetic/projection', 'base',
            '["src"]', '{"retained":"baseline"}', 'accepted', 'pending', 'canonical',
            7, 100, '{"retained":"receipt"}', x'000102', x'030405');`);
      }
      const before = absent
        ? undefined
        : database.prepare("SELECT * FROM local_workspace_projections").get();
      const migration = {
        kind: "state" as const,
        path: pathname,
        foundVersion: 36,
        supportedVersion: OPENCLAW_STATE_SCHEMA_VERSION,
      };
      expect(
        detectOpenClawStateDatabaseSchemaMigrations({ path: pathname, env: state.env }),
      ).toContainEqual({
        kind: "local-workspace-checkpoints-v37",
        path: pathname,
      });
      const tables = resolveSchemaMigrationBackupTables(migration);
      expect(tables).toEqual([
        "config_machine_state",
        "local_workspace_projections",
        "schema_meta",
      ]);
      await withMaintenance(async () => {
        await assertSqliteMigrationScopePreserved(database, tables!, async () => {
          const result = await prepareDoctorDatabaseMigrations({
            env: state.env,
            pendingDatabasePaths: [pathname],
            pendingMigrations: [migration],
            databasePaths: [],
            agentDatabaseTargets: [],
          });
          expect(result.warnings).toEqual([]);
        });
      });
      expect(database.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_STATE_SCHEMA_VERSION,
      });
      if (absent) {
        expect(
          database
            .prepare("SELECT name FROM sqlite_schema WHERE name = 'local_workspace_projections'")
            .all(),
        ).toEqual([]);
      } else {
        expect(database.prepare("SELECT * FROM local_workspace_projections").get()).toEqual({
          ...before,
          filesystem_checkpoints_json: null,
        });
      }
      const archive = fs
        .readdirSync(path.dirname(pathname))
        .find((name) => name.endsWith(".scoped.bak"));
      expect(archive).toBeDefined();
      await restoreDoctorMigrationBackup({
        sourcePath: pathname,
        backupPath: path.join(path.dirname(pathname), archive!),
        env: state.env,
      });
      // A new handle observes the restored schema even on older Node SQLite metadata caches.
      using restored = new DatabaseSync(pathname, { readOnly: true });
      expect(restored.prepare("PRAGMA user_version").get()).toEqual({ user_version: 36 });
      if (!absent) {
        expect(restored.prepare("SELECT * FROM local_workspace_projections").get()).toEqual(before);
      }
    });
  },
);
