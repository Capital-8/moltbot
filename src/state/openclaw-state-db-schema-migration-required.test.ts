import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { createUpdateRun } from "../infra/update-run-ledger.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
} from "./openclaw-state-db.js";
import { removePreparedWorkerOwnershipColumns } from "./openclaw-state-schema-v17.test-support.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";
import {
  addPreCutoverClientCredentialTablesForTest,
  withStateMigrationBackupForTest,
} from "./openclaw-state-schema.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const now = Date.parse("2026-09-07T12:00:00Z");
const graceMs = 5 * 60_000;
const abandonedMs = 30 * 60_000;
const runId = "ed099411-cfbd-4304-a6b7-d3e504a48505";
const secondRunId = "dc43feae-aab9-4f85-9686-89f6c1fe3c12";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
});
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function seedRun(db: EngineConnection, version = "2026.9.2", id = runId) {
  db.prepare(`
    INSERT INTO update_runs (
      run_id, created_at_ms, updated_at_ms, trigger, phase, status,
      origin_json, target_json, before_json, after_json, steps_json, verification_json, repair_json
    ) VALUES (?, ?, ?, 'cli', 'verifying', 'running', '{}', '{}', ?, '{}', '[]', '{}', '[]')
  `).run(id, now - 60_000, now, JSON.stringify({ version }));
}

function createV15Database(version: string | null = "2026.9.2") {
  const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-schema-publication-") } };
  const databasePath = openOpenClawStateDatabase(options).path;
  if (version !== null) {
    createUpdateRun({ runId, trigger: "cli", before: { version } }, options);
  }
  closeOpenClawStateDatabaseForTest();
  const db = new DatabaseSync(databasePath);
  try {
    addPreCutoverClientCredentialTablesForTest(db);
    removePreparedWorkerOwnershipColumns(db);
    db.exec(`
      PRAGMA user_version = 15;
      UPDATE schema_meta SET schema_version = 15 WHERE meta_key = 'primary';
    `);
  } finally {
    db.close();
  }
  return { options, databasePath };
}

function expectVersion(db: EngineConnection, version: number) {
  expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: version });
  expect(
    db.prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'").get(),
  ).toEqual({ schema_version: version });
}

function finishRun(db: EngineConnection, finishedAtMs: number, id = runId) {
  db.prepare(`
    UPDATE update_runs SET status = 'succeeded', phase = 'finished',
      finished_at_ms = ?, updated_at_ms = ? WHERE run_id = ?
  `).run(finishedAtMs, now, id);
}

function reopen(options: Parameters<typeof openOpenClawStateDatabase>[0]) {
  closeOpenClawStateDatabaseForTest();
  return openOpenClawStateDatabase(options).db;
}

describe("shared state schema publication", () => {
  it("migrates v32 without inventing disk authority for legacy repository state", async () => {
    const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("disk-authority-migration-") } };
    const pathname = openOpenClawStateDatabase(options).path;
    closeOpenClawStateDatabaseForTest();
    const legacy = new DatabaseSync(pathname);
    try {
      for (const table of [
        "session_repository_workspaces",
        "worker_session_placements",
        "worker_workspace_pending_results",
      ]) {
        legacy.exec(extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, table));
      }
      legacy.exec(`ALTER TABLE session_repository_workspaces DROP COLUMN disk_authority_json;
        ALTER TABLE worker_workspace_pending_results DROP COLUMN disk_authority_json;
        INSERT INTO session_repository_workspaces (workspace_id,agent_id,session_key,url,branch,revision,created_at_ms,updated_at_ms)
        VALUES ('11111111-1111-1111-1111-111111111111','main','agent:main:synthetic','https://example.invalid/repo.git','openclaw/synthetic',7,1,2);
        PRAGMA user_version = 32;
        UPDATE schema_meta SET schema_version = 32 WHERE meta_key = 'primary';
        UPDATE config_machine_state SET value_json = '32' WHERE state_key = 'state.schema.contentVersion';`);
    } finally {
      legacy.close();
    }
    await withStateMigrationBackupForTest(options, () => openOpenClawStateDatabase(options));
    const db = openOpenClawStateDatabase(options).db;
    expectVersion(db, 33);
    expect(
      db
        .prepare(
          "SELECT revision,disk_authority_json FROM session_repository_workspaces WHERE agent_id='main'",
        )
        .get(),
    ).toEqual({ revision: 7, disk_authority_json: null });
    expect(db.prepare("PRAGMA table_info(worker_workspace_pending_results)").all()).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "disk_authority_json" })]),
    );
    closeOpenClawStateDatabaseForTest();
    expectVersion(openOpenClawStateDatabase(options).db, 33);
  });

  it.each(["runtime open", "doctor repair"] as const)(
    "captured %s applies current content while preserving the unfenced updater's v15 floor",
    async (entry) => {
      const { options } = createV15Database();
      if (entry === "doctor repair") {
        expect(
          (
            await withStateMigrationBackupForTest(options, () =>
              repairOpenClawStateDatabaseSchema(options),
            )
          ).warnings,
        ).toEqual([]);
      }
      await withStateMigrationBackupForTest(options, () => openOpenClawStateDatabase(options));
      const db = openOpenClawStateDatabase(options).db;
      expectVersion(db, 15);
      expect(db.prepare("PRAGMA table_info(worker_environments)").all()).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "preparation_consumed_at_ms" })]),
      );
      expect(
        db
          .prepare(
            "SELECT value_json FROM config_machine_state WHERE state_key = 'state.schema.contentVersion'",
          )
          .get(),
      ).toEqual({ value_json: String(OPENCLAW_STATE_SCHEMA_VERSION) });
    },
  );

  it("skips content on repeated deferred opens and repair", async () => {
    const { options } = createV15Database();
    await withStateMigrationBackupForTest(options, () => openOpenClawStateDatabase(options));
    vi.setSystemTime(now + 60_000);
    expectVersion(reopen(options), 15);
    closeOpenClawStateDatabaseForTest();
    const repair = repairOpenClawStateDatabaseSchema(options);
    expect(repair.warnings).toEqual([]);
    expect(repair.changes).not.toContain(
      "Recorded prepared worker ownership and one-use lifecycle (v17)",
    );
    expectVersion(openOpenClawStateDatabase(options).db, 15);
  });

  it.each([
    { description: "terminal row's finish", terminal: true, duration: graceMs },
    { description: "running row's last update", terminal: false, duration: abandonedMs + 1 },
  ])(
    "publishes only at the deadline anchored to the $description",
    async ({ terminal, duration }) => {
      const { options } = createV15Database();
      await withStateMigrationBackupForTest(options, () => openOpenClawStateDatabase(options));
      const db = openOpenClawStateDatabase(options).db;
      if (terminal) {
        finishRun(db, now);
      }
      vi.setSystemTime(now + duration - 1);
      expectVersion(reopen(options), 15);
      vi.setSystemTime(now + duration);
      expectVersion(openOpenClawStateDatabase(options).db, OPENCLAW_STATE_SCHEMA_VERSION);
    },
  );

  it("uses finished_at_ms even when a terminal record was enriched more recently", async () => {
    const { options } = createV15Database();
    await withStateMigrationBackupForTest(options, () => openOpenClawStateDatabase(options));
    finishRun(openOpenClawStateDatabase(options).db, now - graceMs);
    expectVersion(reopen(options), OPENCLAW_STATE_SCHEMA_VERSION);
  });

  it("publishes deferred content when its legacy ledger row is absent", async () => {
    const { options } = createV15Database();
    await withStateMigrationBackupForTest(options, () => openOpenClawStateDatabase(options));
    openOpenClawStateDatabase(options).db.exec("DELETE FROM update_runs");
    expectVersion(reopen(options), OPENCLAW_STATE_SCHEMA_VERSION);
  });

  it("requires every legacy row to clear its own deadline, including a new running update", async () => {
    const { options } = createV15Database();
    await withStateMigrationBackupForTest(options, () => openOpenClawStateDatabase(options));
    let db = openOpenClawStateDatabase(options).db;
    finishRun(db, now - graceMs);
    seedRun(db, "2026.9.2-1", secondRunId);
    expectVersion((db = reopen(options)), 15);
    finishRun(db, now, secondRunId);
    vi.setSystemTime(now + graceMs - 1);
    expectVersion(reopen(options), 15);
    vi.setSystemTime(now + graceMs);
    expectVersion(reopen(options), OPENCLAW_STATE_SCHEMA_VERSION);
  });

  it.each(["2026.9.1", "2026.9.3", "2026.9.4", null])(
    "publishes immediately for driver %s without creating a deferred marker",
    async (version) => {
      const { options } = createV15Database(version);
      await withStateMigrationBackupForTest(options, () => openOpenClawStateDatabase(options));
      const db = openOpenClawStateDatabase(options).db;
      expectVersion(db, OPENCLAW_STATE_SCHEMA_VERSION);
      expect(
        db
          .prepare(
            "SELECT 1 FROM config_machine_state WHERE state_key = 'state.schema.contentVersion'",
          )
          .get(),
      ).toBeUndefined();
    },
  );

  it("retains the typed manual-update fallback and rolls back on missing metadata", async () => {
    const { options, databasePath } = createV15Database();
    const before = new DatabaseSync(databasePath);
    try {
      before.exec("DROP TABLE config_machine_state");
    } finally {
      before.close();
    }
    await expect(
      withStateMigrationBackupForTest(options, () => openOpenClawStateDatabase(options)),
    ).rejects.toThrow(
      expect.objectContaining({
        name: "UpdateSchemaRefusalError",
      }),
    );
    const after = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expectVersion(after, 15);
      expect(
        after.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'config_machine_state'").get(),
      ).toBeUndefined();
    } finally {
      after.close();
    }
  });
});
