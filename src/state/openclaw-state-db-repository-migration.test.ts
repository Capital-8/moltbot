import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { closeOpenClawStateDatabaseByPathAsync } from "./openclaw-state-db-cache.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { createSessionRepositoryWorkspaceStore } from "./session-repository-workspaces.js";

const paths: string[] = [];
const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    for (const pathname of paths.splice(0)) {
      await closeOpenClawStateDatabaseByPathAsync(pathname);
    }
    cleanup();
  });
});

it("upgrades an existing v31 repository table on cold open without losing its checkpoint", async () => {
  const pathname = path.join(tempDirs.make("repository-schema-upgrade-"), "openclaw.sqlite");
  paths.push(pathname);
  openOpenClawStateDatabase({ path: pathname });
  const store = createSessionRepositoryWorkspaceStore({ path: pathname });
  const assertCurrent = () => {};
  const original = await store.create({
    agentId: "main",
    sessionKey: "agent:main:retained",
    url: "https://github.com/example/project.git",
    assertCurrent,
  });
  const base = await store.bindBase({
    workspaceId: original.workspaceId,
    expectedRevision: original.revision,
    baseCommit: "a".repeat(40),
    baseManifestHash: `sha256:${"b".repeat(64)}`,
    assertCurrent,
  });
  const checkpoint = await store.acceptCheckpoint({
    workspaceId: base.workspaceId,
    expectedRevision: base.revision,
    checkpointRef: "refs/openclaw/worker-results/retained",
    manifestHash: `sha256:${"d".repeat(64)}`,
    assertCurrent,
  });
  await closeOpenClawStateDatabaseByPathAsync(pathname);
  // Model the actual pre-feature table in a disposable, exclusively owned database.
  using legacy = openNodeSqliteDatabase(pathname);
  legacy.exec(
    "ALTER TABLE session_repository_workspaces DROP COLUMN recovery_json; PRAGMA user_version = 31; UPDATE schema_meta SET schema_version = 31 WHERE meta_key = 'primary';",
  );
  legacy
    .prepare(
      "UPDATE config_machine_state SET value_json = '31' WHERE state_key = 'state.schema.contentVersion'",
    )
    .run();
  expect(legacy.prepare("PRAGMA user_version").get()?.user_version).toBe(31);
  legacy.close();

  const reopened = openOpenClawStateDatabase({ path: pathname });
  expect(await store.get(checkpoint.workspaceId)).toEqual(checkpoint);
  const fresh = await store.create({
    agentId: "main",
    sessionKey: "agent:main:fresh",
    url: "https://github.com/example/project.git",
    assertCurrent,
  });
  expect(fresh.sessionKey).toBe("agent:main:fresh");
  expect(await store.get(checkpoint.workspaceId)).toEqual(checkpoint);
  expect(reopened.db.prepare("PRAGMA user_version").get()?.user_version).toBe(
    OPENCLAW_STATE_SCHEMA_VERSION,
  );
});
