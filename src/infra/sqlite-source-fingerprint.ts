import fs from "node:fs";

/**
 * Stat only: closing even a raw descriptor here could release this process's SQLite
 * locks. Root SQLite fchowns the WAL on every open, so only the main file keeps ctime,
 * and an empty WAL holds no frames, so readers creating or removing one change no bytes.
 */
export function readSqliteSourceFingerprint(canonicalPath: string) {
  try {
    const main = fs.statSync(canonicalPath, { bigint: true, throwIfNoEntry: false });
    if (!main?.isFile() || fs.statSync(`${canonicalPath}-journal`, { throwIfNoEntry: false })) {
      return undefined;
    }
    const wal = fs.statSync(`${canonicalPath}-wal`, { bigint: true, throwIfNoEntry: false });
    const frames = wal && wal.size > 0n ? wal : undefined;
    return {
      fingerprint: [
        `${main.dev}:${main.ino}:${main.size}:${main.mtimeNs}:${main.ctimeNs}`,
        frames ? `${frames.dev}:${frames.ino}:${frames.size}:${frames.mtimeNs}` : "none",
      ].join("|"),
      drained: !frames,
      main,
      newestMs: Math.max(Number(main.mtimeMs), Number(frames?.mtimeMs ?? 0)),
    };
  } catch {
    // Callers treat an unreadable source as changed; its real owner reports the failure.
    return undefined;
  }
}
