import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { withAgentDatabaseMaintenanceLease } from "./openclaw-agent-db-maintenance-lease.js";
import { migrateOpenClawAgentDatabaseForMaintenance } from "./openclaw-agent-db-maintenance.js";
import { OPENCLAW_AGENT_SCHEMA_V24_SQL } from "./openclaw-agent-schema-v24.test-support.js";
import { closeOpenClawStateDatabaseAsync, openOpenClawStateDatabase } from "./openclaw-state-db.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(closeOpenClawStateDatabaseAsync);

it("migrates historical agent v24 while retaining input payloads and preventing queued replay", async () => {
  const root = dirs.make("openclaw-historical-agent-");
  const pathname = path.join(root, "agent.sqlite");
  using db = new DatabaseSync(pathname);
  db.exec(OPENCLAW_AGENT_SCHEMA_V24_SQL);
  db.exec(`ALTER TABLE session_pending_inputs ADD COLUMN recovery_intent_json TEXT;
    INSERT INTO schema_meta VALUES ('primary', 'agent', 24, 'main', '2026.9.3', 1, 1);
    PRAGMA user_version = 24;
    INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
      VALUES ('agent:main:history', 'sid-1', '{"sessionId":"sid-1","updatedAt":1}', 1);
    INSERT INTO session_windows (session_id, session_key, created_at, updated_at)
      VALUES ('sid-1', 'agent:main:history', 1, 1);`);
  for (const state of ["queued", "interrupted", "cancelled"]) {
    db.prepare(`INSERT INTO session_pending_inputs
      (input_id,session_key,session_id,idempotency_key,run_id,request_hash,message_json,
       lifecycle_generation,state,accepted_at,recovery_intent_json)
      VALUES (?, 'agent:main:history', 'sid-1', ?, ?, 'hash', ?, 'old-generation', ?, 1, ?)`).run(
      state,
      state,
      `run-${state}`,
      JSON.stringify({ role: "user", content: `Retain ${state}` }),
      state,
      '{"historical":"evidence-only"}',
    );
  }
  const before = db.prepare("SELECT * FROM session_pending_inputs ORDER BY seq").all();
  const payload = db.prepare("SELECT entry_json FROM session_nodes").get();
  db.close();
  const env = { OPENCLAW_STATE_DIR: root };
  openOpenClawStateDatabase({ env });
  await withAgentDatabaseMaintenanceLease({ env, processBound: true }, (maintenance) =>
    migrateOpenClawAgentDatabaseForMaintenance(
      {
        agentId: "main",
        pathname,
        env,
        register: false,
      },
      maintenance,
    ),
  );
  using actual = new DatabaseSync(pathname);
  expect(actual.prepare("PRAGMA user_version").get()).toEqual({
    user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
  });
  expect(actual.prepare("SELECT entry_json FROM session_nodes").get()).toEqual(payload);
  expect(actual.prepare("SELECT * FROM session_pending_inputs ORDER BY seq").all()).toEqual(
    before.map((row) =>
      Object.assign({}, row, {
        state: row.state === "queued" ? "interrupted" : row.state,
        consumed_event_id: null,
      }),
    ),
  );
  expect(actual.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});
