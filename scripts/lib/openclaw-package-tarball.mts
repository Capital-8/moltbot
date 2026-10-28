// Owns package-only TAR admission and extraction; callers own the private workspace lifetime.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { inspectTarArchive } from "@openclaw/fs-safe/archive";
import { root } from "@openclaw/fs-safe/root";
import { extract as extractTar, list as listTar, type ReadEntry } from "tar";

export const PACKAGE_ARCHIVE_LIMITS = {
  maxEntries: 150_000,
  maxExtractedBytes: 2 * 1024 ** 3,
  maxArchiveBytes: 1024 ** 3,
};

type MaterialTarEntry = {
  kind: "directory" | "file";
  path: string;
};

function isRegularTarEntry(entry: ReadEntry): boolean {
  return entry.type === "File" || entry.type === "OldFile" || entry.type === "ContiguousFile";
}

function canonicalMaterialPath(entry: ReadEntry, errors: string[]): string | null {
  const rawPath = entry.header.path ?? "";
  const parseParts = (candidate: string): string[] | null => {
    const parts = candidate.split("/");
    if (
      !candidate ||
      candidate.includes("\\") ||
      candidate.startsWith("/") ||
      /^[A-Za-z]:/u.test(candidate) ||
      parts.some(
        (part, index) =>
          part === "." ||
          part === ".." ||
          (part === "" && index > 0 && !(entry.type === "Directory" && index === parts.length - 1)),
      )
    ) {
      return null;
    }
    if (entry.type === "Directory" && parts.at(-1) === "") {
      parts.pop();
    }
    return parts;
  };
  const rawParts = parseParts(rawPath);
  if (!rawParts) {
    errors.push(`unsafe tar entry path: ${rawPath || "<empty>"}`);
    return null;
  }
  const finalPath = entry.path;
  const parts = finalPath === rawPath ? rawParts : parseParts(finalPath);
  if (!parts) {
    errors.push(`unsafe tar entry path: ${finalPath || "<empty>"}`);
    return null;
  }
  if (parts[0] !== "package" || (parts.length === 1 && entry.type !== "Directory")) {
    errors.push(`tar entry is outside package/: ${finalPath || "<empty>"}`);
    return null;
  }
  return parts.join("/");
}

// tar@7.5.22 winchars.encode applies this mapping before Windows extraction.
function portableExtractionPathKey(value: string): string {
  return value
    .normalize("NFC")
    .replace(/[|<>?:]/gu, (char) => String.fromCodePoint(0xf000 + char.codePointAt(0)!))
    .toLowerCase();
}

function scanTarball(archivePath: string): {
  entries: string[];
  files: string[];
} {
  const errors: string[] = [];
  const materialEntries: MaterialTarEntry[] = [];
  const inspectEntry = (entry: ReadEntry) => {
    const rawPath = entry.header.path ?? entry.path;
    const isFile = isRegularTarEntry(entry);
    if ((!isFile && entry.type !== "Directory") || Boolean(entry.linkpath)) {
      errors.push(`unsupported tar entry type ${entry.type}: ${rawPath}`);
      return;
    }
    const materialPath = canonicalMaterialPath(entry, errors);
    if (!materialPath) {
      return;
    }
    const mode = entry.mode;
    const needsExec = entry.type === "Directory" || (mode !== undefined && (mode & 0o111) !== 0);
    if (mode === undefined || (mode & 0o444) !== 0o444 || (needsExec && (mode & 0o111) !== 0o111)) {
      errors.push(
        `tar entry is not world-readable (${mode === undefined ? "<missing>" : `0${mode.toString(8)}`}): ${rawPath}`,
      );
    }
    materialEntries.push({
      kind: isFile ? "file" : "directory",
      path: materialPath,
    });
  };

  {
    let parseError: Error | undefined;
    const parser = listTar({ sync: true, strict: true, onReadEntry: inspectEntry });
    parser.on("ignoredEntry", inspectEntry);
    parser.on("error", (error: Error) => {
      parseError ??= error;
    });
    const input = fs.openSync(archivePath, "r");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    try {
      let bytesRead = 0;
      while ((bytesRead = fs.readSync(input, chunk, 0, chunk.length, null)) > 0) {
        parser.write(chunk.subarray(0, bytesRead));
        if (parseError) {
          break;
        }
      }
      if (!parseError) {
        parser.end();
      }
    } finally {
      fs.closeSync(input);
    }
    if (parseError) {
      throw parseError;
    }
  }

  const exactPaths = new Map<string, MaterialTarEntry>();
  const portablePaths = new Map<string, MaterialTarEntry>();
  for (const entry of materialEntries) {
    const existing = exactPaths.get(entry.path);
    if (existing) {
      errors.push(
        existing.kind === entry.kind
          ? `package tarball contains duplicate paths: ${entry.path}`
          : `package tarball contains file-directory conflict: ${entry.path}`,
      );
    } else {
      exactPaths.set(entry.path, entry);
    }
    const portablePath = portableExtractionPathKey(entry.path);
    const portableExisting = portablePaths.get(portablePath);
    if (portableExisting && portableExisting.path !== entry.path) {
      errors.push(
        `package tarball contains portable path collision: ${portableExisting.path}, ${entry.path}`,
      );
    } else {
      portablePaths.set(portablePath, entry);
    }
  }
  for (const entry of exactPaths.values()) {
    const parts = entry.path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      const ancestor = portablePaths.get(
        portableExtractionPathKey(parts.slice(0, index).join("/")),
      );
      if (ancestor?.kind === "file") {
        errors.push(
          `package tarball contains file-ancestor conflict: ${ancestor.path}, ${entry.path}`,
        );
        break;
      }
    }
  }
  const packageManifests = materialEntries.filter(
    (entry) => entry.path === "package/package.json" && entry.kind === "file",
  );
  if (packageManifests.length !== 1) {
    errors.push(
      `package tarball must contain exactly one regular package/package.json (found ${packageManifests.length})`,
    );
  }
  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }

  return {
    entries: [...exactPaths.values()]
      .filter((entry) => entry.path !== "package")
      .map((entry) => {
        const relativePath = entry.path.slice("package/".length);
        return entry.kind === "directory" ? `${relativePath}/` : relativePath;
      }),
    files: [...exactPaths.values()]
      .filter((entry) => entry.kind === "file")
      .map((entry) => entry.path.slice("package/".length)),
  };
}

export async function extractPackageTarball(options: {
  tarball: string;
  workspace: string;
  expected?: { sha256: string; bytes: number };
  inspectLimits?: boolean;
}) {
  const archiveSnapshot = path.join(options.workspace, "candidate.tgz");
  const extractDir = path.join(options.workspace, "extract");
  const workspace = await root(options.workspace);
  await workspace.copyIn("candidate.tgz", path.resolve(options.tarball), {
    overwrite: false,
    durable: false,
    mode: 0o400,
    maxBytes: PACKAGE_ARCHIVE_LIMITS.maxArchiveBytes,
  });
  if (options.expected) {
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of fs.createReadStream(archiveSnapshot)) {
      bytes += chunk.length;
      hash.update(chunk);
    }
    if (bytes !== options.expected.bytes || hash.digest("hex") !== options.expected.sha256) {
      throw new Error("Portable package snapshot digest/size mismatch");
    }
  }
  // Native public inspection owns decoded/header/path/meta budgets. The package
  // scanner adds the narrower no-links, package-root and portable collision policy.
  if (options.inspectLimits) {
    await inspectTarArchive({
      archivePath: archiveSnapshot,
      timeoutMs: 120_000,
      limits: PACKAGE_ARCHIVE_LIMITS,
    });
  }
  const inventory = scanTarball(archiveSnapshot);
  fs.mkdirSync(extractDir);
  extractTar({
    cwd: extractDir,
    file: archiveSnapshot,
    preserveOwner: false,
    strict: true,
    sync: true,
    // Match the generic archive owner's safe mode policy, independent of umask.
    ...(options.inspectLimits ? { noChmod: false, umask: 0, dmode: 0o755 } : {}),
    onReadEntry(entry) {
      if (!options.inspectLimits) {
        return;
      }
      entry.mode = entry.type === "Directory" || ((entry.mode ?? 0) & 0o100) !== 0 ? 0o755 : 0o644;
    },
  });
  return inventory;
}
