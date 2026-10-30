import fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { getEnvironmentData, setEnvironmentData } from "node:worker_threads";

const key = "openclaw.test.readinessNativeReads";
const { entry, source, counts: buffer } = getEnvironmentData(key);
setEnvironmentData(key, undefined);
const counts = new Int32Array(buffer);
const privateImages = new Set();
if (process.versions.bun) {
  const { ensureSqliteLibrarySelected } = await import("../../infra/bun-sqlite-library.ts");
  ensureSqliteLibrarySelected();
}
const sqlite = createRequire(import.meta.url)("node:sqlite");
// Call through at the native I/O boundary; qualification and SQL remain production-owned.
sqlite.DatabaseSync = new Proxy(sqlite.DatabaseSync, {
  construct(target, args, newTarget) {
    const database = Reflect.construct(target, args, newTarget);
    Atomics.add(counts, 0, 1);
    const location = database.location();
    if (
      counts.length > 4 &&
      String(location).includes("openclaw-sqlite-readonly-") &&
      !privateImages.has(location)
    ) {
      privateImages.add(location);
      const size = fs.statSync(location).size;
      if (size > 0) {
        Atomics.add(counts, 4, 1);
        for (const suffix of ["", "-wal", "-shm", "-journal"]) {
          const stat = fs.statSync(location + suffix, { throwIfNoEntry: false });
          if (stat) {
            Atomics.add(counts, 5, stat.size);
          }
        }
      }
    }
    if (database.location() === source) {
      Atomics.add(counts, 1, 1);
    }
    return database;
  },
});
if (counts.length > 6) {
  const prepare = sqlite.DatabaseSync.prototype.prepare;
  sqlite.DatabaseSync.prototype.prepare = function (sql) {
    const statement = Reflect.apply(prepare, this, [sql]);
    if (this.location() === source && /select/i.test(sql) && /session_nodes/i.test(sql)) {
      for (const method of ["get", "all", "iterate"]) {
        const execute = statement[method];
        statement[method] = function (...params) {
          Atomics.add(counts, 6, 1);
          return Reflect.apply(execute, this, params);
        };
      }
    }
    return statement;
  };
}
const stat = fs.statSync;
fs.statSync = function (...args) {
  if (args[0] === source) {
    Atomics.add(counts, 2, 1);
  }
  return Reflect.apply(stat, fs, args);
};
const realpath = fs.realpathSync.native;
fs.realpathSync.native = function (...args) {
  if (args[0] === source) {
    Atomics.add(counts, 3, 1);
  }
  return Reflect.apply(realpath, fs.realpathSync, args);
};
syncBuiltinESMExports();
await import(entry);
