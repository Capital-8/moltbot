import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createWorkerEnvironmentAccess } from "../gateway/worker-environments/environment-access.js";
import { readWorkerPreparation } from "../gateway/worker-environments/preparation-identity.schema.js";
import { readWorkerProjectSnapshot } from "../gateway/worker-environments/project-preparation.js";
import { createWorkerEnvironmentStore } from "../gateway/worker-environments/store.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { migrateHistoricalImageReserveSnapshots } from "./openclaw-state-db-teamclaw-migration.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  prepareOpenClawStateDatabaseSchema,
  repairOpenClawStateDatabaseSchema,
} from "./openclaw-state-db.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(closeOpenClawStateDatabaseAsync);
const preparation = {
  key: "a".repeat(64),
  cacheKey: "c".repeat(64),
  contractVersion: 1,
  target: { machineClass: "small", platform: "linux" },
  artifacts: {
    nodeBootstrapSha256: "d".repeat(64),
    enabledPluginIds: [],
    workerBundleHash: "e".repeat(64),
    workerArchiveSha256: "f".repeat(64),
    openclawVersion: "synthetic",
    protocolFeatures: [],
  },
};
const original = JSON.stringify({
  install: "bundle",
  settings: { provider: "azure-sandbox" },
  project: { kind: "image", key: "b".repeat(64), preparation },
});

function seed(db: DatabaseSync, snapshot = original) {
  db.prepare(`INSERT INTO worker_environments
    (environment_id,provider_id,profile_id,profile_snapshot_json,provision_operation_id,lease_id,
     preparation_key,preparation_purpose,preparation_demand_at_ms,preparation_expires_at_ms,
     preparation_consumed_at_ms,state,owner_epoch,attached_session_ids_json,
     created_at_ms,updated_at_ms,state_changed_at_ms,destroy_requested_at_ms)
    VALUES ('worker:historical-image','crabbox','sandbox',?,'provision:historical-image','cbx_0123456789ab',
      ?,'reserve',1000,2000,1500,'destroyed',7,'[]',1,2,2,2)`).run(snapshot, preparation.key);
}

it("Doctor cuts over schema22 image snapshots and restores the session environment listing without changing custody", async () => {
  const env = { OPENCLAW_STATE_DIR: dirs.make("openclaw-image-snapshot-migration-") };
  const pathname = openOpenClawStateDatabase({ env }).path;
  await closeOpenClawStateDatabaseAsync();
  using db = new DatabaseSync(pathname);
  seed(db);
  const before = db.prepare("SELECT * FROM worker_environments").get()!;
  expect(() => readWorkerProjectSnapshot(JSON.parse(original).project)).toThrow(
    "invalid project preparation snapshot",
  );
  db.close();
  expect(
    (await prepareOpenClawStateDatabaseSchema({ env }, "doctor-preparation")).warnings,
  ).toEqual([]);
  const database = openOpenClawStateDatabase({ env });
  const after = database.db.prepare("SELECT * FROM worker_environments").get()!;
  expect(after).toEqual({ ...before, profile_snapshot_json: expect.any(String) });
  const profile = JSON.parse(String(after.profile_snapshot_json));
  expect(profile.historicalProfileSnapshotJson).toBe(original);
  expect(profile.project).toBeUndefined();
  expect(readWorkerPreparation(profile)).toEqual({ ...preparation, source: "image" });
  const store = await createWorkerEnvironmentStore({ database });
  const unexpected = () => {
    throw new Error("Listing cannot provision, prepare, or authorize a repository");
  };
  const access = createWorkerEnvironmentAccess({
    store,
    getConfig: () => ({}),
    getCleanupError: () => undefined,
    readStartStatus: () => undefined,
    prepareCurrentBundle: async () => unexpected(),
    providerFor: unexpected,
    resolveProvider: unexpected,
    identityResolverFor: unexpected,
    now: () => 3000,
    isStopping: () => false,
    withLock: async (_id, task) => task(),
  });
  try {
    expect(access.list()).toMatchObject([
      {
        environmentId: "worker:historical-image",
        state: "destroyed",
        ownerEpoch: 7,
        preparation: {
          key: preparation.key,
          demandAtMs: 1000,
          expiresAtMs: 2000,
          consumedAtMs: 1500,
        },
      },
    ]);
  } finally {
    await store.close();
  }
  await closeOpenClawStateDatabaseAsync();
  expect(repairOpenClawStateDatabaseSchema({ env }).changes).not.toContain(
    "Migrated historical image reserves to runtime preparation with original snapshot evidence retained",
  );
  expect(
    openOpenClawStateDatabase({ env }).db.prepare("SELECT * FROM worker_environments").get(),
  ).toEqual(after);
});

it("rolls back malformed historical image preparation instead of discarding its record", () => {
  using db = new DatabaseSync(":memory:");
  db.exec(
    `CREATE TABLE worker_environments (environment_id TEXT PRIMARY KEY, profile_snapshot_json TEXT NOT NULL)`,
  );
  db.prepare("INSERT INTO worker_environments VALUES ('valid', ?), ('invalid', ?)").run(
    original,
    JSON.stringify({ project: { kind: "image", key: "b".repeat(64), preparation: {} } }),
  );
  const before = db.prepare("SELECT * FROM worker_environments ORDER BY environment_id").all();
  expect(() =>
    runSqliteImmediateTransactionSync(db, () => migrateHistoricalImageReserveSnapshots(db)),
  ).toThrow("Worker runtime preparation identity is invalid");
  expect(db.prepare("SELECT * FROM worker_environments ORDER BY environment_id").all()).toEqual(
    before,
  );
});
