/**
 * WAL commit latency under idle and sibling-file write load (synthetic data only).
 * node scripts/perf/wal-synchronous-commit.mjs <output-directory> [seconds=15] [pairs=2]
 * Each arm commits 1 KiB updates for >=seconds and >=10,000 transactions. AB/BA
 * order alternates; automatic checkpoints remain enabled at the runtime's 16,384
 * page threshold. The loaded arm writes/fsyncs a 4 GiB sibling repeatedly, then
 * joins it without signals. All fixtures are removed; JSON results remain.
 * This compares SQLite policies, not Gateway throughput or power-loss recovery.
 */
import assert from "node:assert/strict";
import { randomFillSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { Worker, isMainThread, workerData } from "node:worker_threads";

const MiB = 1024 * 1024;

if (!isMainThread) {
  const control = new Int32Array(workerData.control);
  const block = randomFillSync(Buffer.alloc(8 * MiB));
  const fd = fs.openSync(workerData.file, "wx");
  try {
    do {
      for (let offset = 0; offset < 4096 * MiB; offset += block.length) {
        let written = 0;
        while (written < block.length) {
          written += fs.writeSync(fd, block, written, block.length - written, offset + written);
        }
        Atomics.add(control, 1, 8);
      }
      fs.fsyncSync(fd);
    } while (Atomics.load(control, 0) === 0);
  } finally {
    fs.closeSync(fd);
  }
} else {
  const output = path.resolve(process.argv[2] ?? ".local/wal-synchronous-commit");
  const seconds = Number(process.argv[3] ?? 15);
  const pairs = Number(process.argv[4] ?? 2);
  assert(Number.isFinite(seconds) && seconds > 0);
  assert(Number.isInteger(pairs) && pairs > 0);
  fs.mkdirSync(output, { recursive: true });
  const root = fs.mkdtempSync(path.join(output, "fixtures-"));
  const rows = [];
  try {
    for (const loaded of [false, true]) {
      for (let pair = 0; pair < pairs; pair++) {
        for (const mode of pair % 2 === 0 ? ["FULL", "NORMAL"] : ["NORMAL", "FULL"]) {
          const directory = fs.mkdtempSync(path.join(root, "arm-"));
          const db = new DatabaseSync(path.join(directory, "bench.sqlite"));
          const control = new Int32Array(new SharedArrayBuffer(8));
          let writerDone;
          let row;
          try {
            db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=${mode};
              PRAGMA wal_autocheckpoint=16384;
              CREATE TABLE entries(id INTEGER PRIMARY KEY, value BLOB);
              INSERT INTO entries VALUES(1, zeroblob(1024));`);
            if (process.platform === "darwin") {
              db.exec("PRAGMA checkpoint_fullfsync=ON");
            }
            assert.equal(
              db.prepare("PRAGMA synchronous").get().synchronous,
              mode === "FULL" ? 2 : 1,
            );
            const write = db.prepare("UPDATE entries SET value=? WHERE id=1");
            const payload = randomFillSync(Buffer.alloc(1024));
            if (loaded) {
              const worker = new Worker(new URL(import.meta.url), {
                workerData: { control: control.buffer, file: path.join(directory, "sibling.bin") },
              });
              writerDone = new Promise((resolve, reject) => {
                worker.once("error", reject);
                worker.once("exit", (code) =>
                  code === 0 ? resolve() : reject(new Error(`writer exit ${code}`)),
                );
              });
              // Surface writer failures while waiting for disk load to begin.
              while (Atomics.load(control, 1) < 256) {
                await Promise.race([
                  writerDone.then(() => {
                    throw new Error("writer exited before load");
                  }),
                  new Promise((resolve) => {
                    setTimeout(resolve, 10);
                  }),
                ]);
              }
            }
            const commits = [];
            const loadStart = os.loadavg();
            const writeStart = Atomics.load(control, 1);
            const cpuStart = process.threadCpuUsage();
            const started = performance.now();
            do {
              payload.writeUInt32LE(commits.length >>> 0, 0);
              db.exec("BEGIN IMMEDIATE");
              write.run(payload);
              const beforeCommit = performance.now();
              db.exec("COMMIT");
              commits.push(performance.now() - beforeCommit);
            } while (commits.length < 10_000 || performance.now() - started < seconds * 1000);
            const elapsedMs = performance.now() - started;
            const cpu = process.threadCpuUsage(cpuStart);
            const writerMiBDuring = Atomics.load(control, 1) - writeStart;
            commits.sort((a, b) => a - b);
            row = {
              loaded,
              pair,
              mode,
              samples: commits.length,
              elapsedMs,
              commitP50Ms: commits[Math.floor(commits.length * 0.5)],
              commitP99Ms: commits[Math.floor(commits.length * 0.99)],
              commitMaxMs: commits.at(-1),
              cpuUsPerTransaction: (cpu.user + cpu.system) / commits.length,
              writerMiBDuring,
              loadStart,
              loadEnd: os.loadavg(),
            };
          } finally {
            Atomics.store(control, 0, 1);
            try {
              await writerDone;
            } finally {
              try {
                db.close();
              } finally {
                fs.rmSync(directory, { recursive: true });
              }
            }
          }
          rows.push(row);
          console.log(JSON.stringify(row));
        }
      }
    }
  } finally {
    try {
      fs.writeFileSync(
        path.join(output, "results.json"),
        JSON.stringify(
          {
            node: process.version,
            platform: process.platform,
            filesystem: fs.statfsSync(root).type,
            seconds,
            pairs,
            complete: rows.length === pairs * 4,
            rows,
          },
          null,
          2,
        ),
      );
    } finally {
      fs.rmSync(root, { recursive: true });
    }
  }
}
