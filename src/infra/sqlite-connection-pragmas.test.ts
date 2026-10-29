import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  sqliteMaintenanceFixture,
  spySqliteExec,
  thrownBy,
} from "./sqlite-maintenance-fixture.test-support.js";
import { configureSqliteConnectionPragmas } from "./sqlite-wal.js";

const resources = sqliteMaintenanceFixture();

describe("SQLite connection pragma acquisition", () => {
  it.each(["wal", "memory", "rollback"])("defaults only WAL connections to NORMAL: %s", (mode) => {
    const databasePath = mode === "memory" ? ":memory:" : resources.file();
    const db = resources.open(databasePath);
    if (mode === "rollback") {
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      const stat = fs.statfsSync(databasePath);
      stat.type = 0x6969;
      vi.spyOn(fs, "statfsSync").mockReturnValue(stat);
    }
    const maintenance = configureSqliteConnectionPragmas(db, {
      databasePath,
      checkpointIntervalMs: 0,
    });
    try {
      expect(db.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe(
        mode === "rollback" ? "delete" : mode,
      );
      expect(db.prepare("PRAGMA synchronous").get()?.synchronous).toBe(mode === "wal" ? 1 : 2);
    } finally {
      maintenance.close();
    }
  });

  it.each(["FULL", "EXTRA"] as const)(
    "retains an explicit %s durability contract",
    (synchronous) => {
      const db = resources.open(resources.file());
      const maintenance = configureSqliteConnectionPragmas(db, {
        synchronous,
        checkpointIntervalMs: 0,
      });
      try {
        expect(db.prepare("PRAGMA synchronous").get()?.synchronous).toBe(
          synchronous === "FULL" ? 2 : 3,
        );
      } finally {
        maintenance.close();
      }
    },
  );

  it("releases unpublished maintenance when a connection pragma fails", () => {
    const pragma = "synchronous = NORMAL";
    vi.useFakeTimers();
    const dbPath = resources.file();
    const db = resources.open(dbPath);
    const failure = new Error("connection pragma failed");
    db.exec("CREATE TABLE payload (value TEXT); INSERT INTO payload VALUES ('committed');");
    const execSpy = spySqliteExec(db, (sql) => {
      if (sql === `PRAGMA ${pragma};`) {
        expect(vi.getTimerCount()).toBe(1);
        throw failure;
      }
    });
    const acquire = () =>
      configureSqliteConnectionPragmas(db, {
        databasePath: dbPath,
        foreignKeys: true,
        synchronous: "NORMAL",
      });
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(acquire).toThrow(failure);
      expect(vi.getTimerCount()).toBe(0);
      expect(db.isOpen).toBe(true);
    }
    execSpy.mockRestore();
    const maintenance = acquire();
    try {
      expect(db.prepare("SELECT value FROM payload").all()).toEqual([{ value: "committed" }]);
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      maintenance.close();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains the pragma failure when maintenance cleanup also throws", () => {
    vi.useFakeTimers();
    const dbPath = resources.file();
    const db = resources.open(dbPath);
    const failure = new Error("connection pragma failed");
    const checkpointFailure = new Error("checkpoint failed");
    const reportFailure = new Error("checkpoint error reporting failed");
    spySqliteExec(db, (sql) => {
      if (sql === "PRAGMA foreign_keys = ON;") {
        throw failure;
      }
    });
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql) => {
      if (sql.startsWith("PRAGMA wal_checkpoint")) {
        throw checkpointFailure;
      }
      return prepare(sql);
    });
    const caught = thrownBy(() => {
      configureSqliteConnectionPragmas(db, {
        databasePath: dbPath,
        foreignKeys: true,
        onCheckpointError: () => {
          throw reportFailure;
        },
      });
    });
    expect(caught).toBeInstanceOf(AggregateError);
    expect(caught).toMatchObject({ cause: failure, errors: [failure, reportFailure] });
    expect(vi.getTimerCount()).toBe(0);
    expect(db.isOpen).toBe(true);
  });
});
