import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, expect, it, vi } from "vitest";
import { withArtifactPreservingStateReads } from "../state/artifact-preserving-state-reads.js";
import { useSqliteTempDirs } from "./sqlite-shard-lifecycle.test-support.js";
import { readUpdateStateSchemaVersionsInProcess } from "./update-candidate-state.js";

const copies = vi.hoisted(() => ({ count: 0 }));

vi.mock("./sqlite-readonly-location.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./sqlite-readonly-location.js")>();
  return {
    ...original,
    prepareSqliteReadOnlyLocationSyncInProcess: (
      ...args: Parameters<typeof original.prepareSqliteReadOnlyLocationSyncInProcess>
    ) => {
      copies.count += 1;
      return original.prepareSqliteReadOnlyLocationSyncInProcess(...args);
    },
  };
});

const directories = useSqliteTempDirs();

function seed() {
  const stateDir = directories.make("update-state-drained-");
  const shared = path.join(stateDir, "state", "openclaw.sqlite");
  fs.mkdirSync(path.dirname(shared));
  const db = new DatabaseSync(shared);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA user_version = 7; CREATE TABLE probe(value);");
  return { stateDir, shared, db, stagingRoot: directories.make("update-state-staging-") };
}

function inspect(stateDir: string, stagingRoot: string) {
  return withArtifactPreservingStateReads(() =>
    readUpdateStateSchemaVersionsInProcess({
      stateDir,
      config: {},
      stagingRoot,
      preserveSourceArtifacts: true,
    }),
  );
}

beforeEach(() => {
  copies.count = 0;
});

it("reads a drained shared database without copying it or creating sidecars", async () => {
  const { stateDir, shared, db, stagingRoot } = seed();
  db.close();
  const before = fs.readdirSync(path.dirname(shared));
  const versions = await inspect(stateDir, stagingRoot);
  expect(versions.find((entry) => entry.path === shared)?.userVersion).toBe(7);
  expect(copies.count).toBe(0);
  expect(fs.readdirSync(path.dirname(shared))).toEqual(before);
});

it("copies when WAL frames hold commits the main file lacks", async () => {
  const { stateDir, shared, db, stagingRoot } = seed();
  db.exec("PRAGMA wal_autocheckpoint = 0; PRAGMA user_version = 8; INSERT INTO probe VALUES (1);");
  try {
    const versions = await inspect(stateDir, stagingRoot);
    expect(versions.find((entry) => entry.path === shared)?.userVersion).toBe(8);
    expect(copies.count).toBe(1);
  } finally {
    db.close();
  }
});
