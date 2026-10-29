import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { installSqliteFtsTokenizerMismatch } from "./sqlite-index-corruption.test-support.js";
import {
  runSqliteIntegrityOperationSync,
  type SqliteIntegrityOperation,
} from "./sqlite-integrity.js";
const roots = useAutoCleanupTempDirTracker(afterEach);
function fixture() {
  const pathname = path.join(roots.make("startup-integrity-driver-"), "db.sqlite");
  {
    using db = new DatabaseSync(pathname);
    db.exec(
      "CREATE VIRTUAL TABLE owned_fts USING fts5(text); INSERT INTO owned_fts VALUES ('ab'||char(65534)||'cd')",
    );
  }
  installSqliteFtsTokenizerMismatch(pathname, "owned_fts");
  return { pathname, db: new DatabaseSync(pathname) };
}
it("rechecks SQLite rather than trusting a repair callback boolean", () => {
  const { pathname, db } = fixture();
  using owned = db;
  void owned;
  function* steps(): SqliteIntegrityOperation<string> {
    yield { database: db, databaseLabel: pathname };
    return "healthy";
  }
  const repair = vi.fn(() => true);
  expect(() => runSqliteIntegrityOperationSync(steps(), undefined, repair)).toThrow(
    /integrity_check/,
  );
  expect(repair).toHaveBeenCalledTimes(1);
});
it("resumes with the original corruption error when repair fails", () => {
  const { pathname, db } = fixture();
  using owned = db;
  void owned;
  let original: unknown;
  let resumed: unknown;
  function* steps(): SqliteIntegrityOperation<void> {
    try {
      yield { database: db, databaseLabel: pathname };
    } catch (error) {
      resumed = error;
      throw error;
    }
  }
  expect(() =>
    runSqliteIntegrityOperationSync(steps(), undefined, (_check, error) => {
      original = error;
      throw new Error("backup failed");
    }),
  ).toThrow(/Startup FTS repair failed.*backup failed/);
  expect(resumed).toBe(original);
});
it("revalidates authority before repair and never resumes healthy after revocation", () => {
  const { pathname, db } = fixture();
  using owned = db;
  void owned;
  const repair = vi.fn(() => true);
  let validations = 0;
  function* steps(): SqliteIntegrityOperation<void> {
    yield { database: db, databaseLabel: pathname };
  }
  expect(() =>
    runSqliteIntegrityOperationSync(
      steps(),
      () => {
        if (++validations === 2) {
          throw new Error("source revoked");
        }
      },
      repair,
    ),
  ).toThrow(/source revoked/);
  expect(repair).not.toHaveBeenCalled();
});
it("requires successful physical integrity before healthy resumption", () => {
  const { pathname, db } = fixture();
  using owned = db;
  void owned;
  function* steps(): SqliteIntegrityOperation<string> {
    yield { database: db, databaseLabel: pathname };
    return "healthy";
  }
  expect(
    runSqliteIntegrityOperationSync(steps(), undefined, () => {
      db.exec("INSERT INTO owned_fts(owned_fts) VALUES('rebuild')");
      return true;
    }),
  ).toBe("healthy");
});
