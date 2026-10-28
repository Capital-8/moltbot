import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { CONTENT_VERSION_KEY } from "./openclaw-state-db-schema-version.js";
import { closeOpenClawStateDatabaseAsync, openOpenClawStateDatabase } from "./openclaw-state-db.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
});

it("migrates v31 placements without manufacturing historical native association", async () => {
  const pathname = path.join(directories.make("native-loss-migration-"), "openclaw.sqlite");
  const database = openOpenClawStateDatabase({ path: pathname });
  // Offline schema fixture: no worker authority or fabricated lifecycle receipt is involved.
  database.db
    .prepare(
      "INSERT INTO worker_session_placements (session_id, agent_id, session_key, state, created_at_ms, updated_at_ms, state_changed_at_ms) VALUES ('legacy-session', 'main', 'agent:main:legacy-session', 'local', 1, 1, 1)",
    )
    .run();
  const original = database.db
    .prepare("SELECT * FROM worker_session_placements WHERE session_id = 'legacy-session'")
    .get();
  await closeOpenClawStateDatabaseAsync();
  using legacy = openNodeSqliteDatabase(pathname);
  legacy.exec(
    "ALTER TABLE worker_session_placements DROP COLUMN confirmed_loss_recovery_json; PRAGMA user_version = 31; UPDATE schema_meta SET schema_version = 31 WHERE meta_key = 'primary';",
  );
  legacy
    .prepare("UPDATE config_machine_state SET value_json = '31' WHERE state_key = ?")
    .run(CONTENT_VERSION_KEY);
  legacy.close();
  const reopened = openOpenClawStateDatabase({ path: pathname });
  expect(
    reopened.db
      .prepare("SELECT * FROM worker_session_placements WHERE session_id = 'legacy-session'")
      .get(),
  ).toEqual(original);
  expect(reopened.db.prepare("PRAGMA user_version").get()?.user_version).toBe(
    OPENCLAW_STATE_SCHEMA_VERSION,
  );
  const columns = reopened.db.prepare("PRAGMA table_info(worker_session_placements)").all();
  expect(columns).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "confirmed_loss_recovery_json", dflt_value: null }),
    ]),
  );
  await closeOpenClawStateDatabaseAsync();
  expect(
    openOpenClawStateDatabase({ path: pathname }).db.prepare("PRAGMA user_version").get()
      ?.user_version,
  ).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
});

it("refuses a newer writer header before touching native ownership data", async () => {
  const pathname = path.join(directories.make("native-loss-newer-"), "openclaw.sqlite");
  openOpenClawStateDatabase({ path: pathname });
  await closeOpenClawStateDatabaseAsync();
  using newer = openNodeSqliteDatabase(pathname);
  newer.exec("PRAGMA user_version = " + (OPENCLAW_STATE_SCHEMA_VERSION + 1));
  newer.close();
  expect(() => openOpenClawStateDatabase({ path: pathname })).toThrow(/newer|schema version/i);
});
