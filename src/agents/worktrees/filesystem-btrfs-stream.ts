import { isUtf8 } from "node:buffer";

const MAGIC = Buffer.from("btrfs-stream\0");
export const MAX_BTRFS_CHECKPOINT_STREAM_BYTES = 64 * 1024 * 1024;
const CRC32C_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) {
    crc = (crc >>> 1) ^ (crc & 1 ? 0x82f63b78 : 0);
  }
  return crc >>> 0;
});

function commandChecksum(bytes: Buffer): number {
  let crc = 0;
  for (let index = 0; index < bytes.length; index++) {
    const byte = index >= 6 && index < 10 ? 0 : bytes[index]!;
    crc = CRC32C_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return crc >>> 0;
}

function uuid(bytes: Buffer | undefined): string | undefined {
  if (bytes?.length !== 16) {
    return undefined;
  }
  const value = bytes.toString("hex");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

/** Decode v1 kernel send records, never the human-readable receive dump. */
export function parseBtrfsCheckpointChanges(
  stream: Buffer,
  expected: { snapshotUuid: string; parentUuid: string },
): { roots: ReadonlySet<string>; paths: ReadonlySet<string> } | null {
  if (
    stream.length < MAGIC.length + 4 ||
    stream.length > MAX_BTRFS_CHECKPOINT_STREAM_BYTES ||
    !stream.subarray(0, MAGIC.length).equals(MAGIC) ||
    stream.readUInt32LE(MAGIC.length) !== 1
  ) {
    return null;
  }
  const roots = new Set<string>();
  const paths = new Set<string>();
  const addPath = (bytes: Buffer | undefined): boolean => {
    if (!bytes?.length || !isUtf8(bytes)) {
      return false;
    }
    const value = bytes.toString("utf8");
    if (
      value.includes("\0") ||
      value.includes("\\") ||
      value.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      return false;
    }
    roots.add(value.slice(0, !value.includes("/") ? value.length : value.indexOf("/")));
    paths.add(value);
    return true;
  };
  let offset = MAGIC.length + 4;
  let started = false;
  while (offset < stream.length) {
    if (stream.length - offset < 10) {
      return null;
    }
    const length = stream.readUInt32LE(offset);
    const command = stream.readUInt16LE(offset + 4);
    const end = offset + 10 + length;
    if (length + 10 > 64 * 1024 || end > stream.length) {
      return null;
    }
    const record = stream.subarray(offset, end);
    if (commandChecksum(record) !== stream.readUInt32LE(offset + 6)) {
      return null;
    }
    const attributes = new Map<number, Buffer>();
    for (let cursor = offset + 10; cursor < end;) {
      if (end - cursor < 4) {
        return null;
      }
      const kind = stream.readUInt16LE(cursor);
      const size = stream.readUInt16LE(cursor + 2);
      cursor += 4;
      if (kind < 1 || kind > 24 || cursor + size > end || attributes.has(kind)) {
        return null;
      }
      attributes.set(kind, stream.subarray(cursor, cursor + size));
      cursor += size;
    }
    offset = end;
    if (!started) {
      // Full streams and streams for a different snapshot cannot certify a delta.
      if (
        command !== 2 ||
        uuid(attributes.get(1)) !== expected.snapshotUuid ||
        uuid(attributes.get(20)) !== expected.parentUuid
      ) {
        return null;
      }
      started = true;
      continue;
    }
    if (command === 21) {
      return length === 0 && offset === stream.length ? { roots, paths } : null;
    }
    // None of these metadata fields participate in the portable workspace manifest.
    // In particular, ignoring atime-only updates prevents reads from dirtying every root.
    if (command === 13 || command === 14 || command === 19 || command === 20) {
      continue;
    }
    if (!((command >= 3 && command <= 12) || (command >= 15 && command <= 18) || command === 22)) {
      return null;
    }
    if (!addPath(attributes.get(15))) {
      return null;
    }
    // A symlink target (also PATH_LINK) is data; only hardlinks name another source path.
    if (
      (command === 9 && !addPath(attributes.get(16))) ||
      (command === 10 && !addPath(attributes.get(17)))
    ) {
      return null;
    }
  }
  return null;
}
