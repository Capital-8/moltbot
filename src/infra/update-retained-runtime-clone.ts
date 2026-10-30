import fsSync, { type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { sameFileMutationFingerprint, sameFileMutationMetadata } from "./file-descriptor.js";
import { FsSafeError, root as openRoot, type Root } from "./fs-safe.js";
import { hasNodeErrorCode } from "./path-guards.js";
import {
  observeUpdateCandidatePluginTrees,
  type CapturedRuntimeFile,
} from "./update-candidate-plugin-tree.js";

class CloneFallback extends Error {}

/** Unsupported capture and mutable input retry only through the full legacy byte proof. */
export function canFallbackFromRuntimeClone(error: unknown): boolean {
  return (
    error instanceof CloneFallback ||
    (error instanceof FsSafeError &&
      [
        "helper-unavailable",
        "unsupported-platform",
        "path-mismatch",
        "too-large",
        "symlink",
        "not-file",
        "not-found",
      ].includes(error.code)) ||
    hasNodeErrorCode(error, "ENOENT")
  );
}

export async function captureRetainedRuntimeTree(
  params: Parameters<typeof observeUpdateCandidatePluginTrees>[0],
) {
  if (process.platform === "win32") {
    throw new CloneFallback("Windows clone capture has not been qualified");
  }
  const destinationRoot = await openRoot(params.targetStateDir);
  const destinationDevice = (await fs.stat(params.targetStateDir, { bigint: true })).dev;
  const captured = new Map<string, Promise<CapturedRuntimeFile>>();
  const directories = new Map<string, Promise<void>>();
  const prepareDirectory = (directory: string) => {
    let preparing = directories.get(directory);
    if (!preparing) {
      preparing = fs.mkdir(directory, { recursive: true, mode: 0o700 }).then(() => {});
      directories.set(directory, preparing);
    }
    return preparing;
  };
  const capture = (file: string, expected: BigIntStats): Promise<CapturedRuntimeFile> => {
    let capturing = captured.get(file);
    if (!capturing) {
      capturing = (async () => {
        if (
          !expected.isFile() ||
          expected.dev !== destinationDevice ||
          (expected.mode & 0o7000n) !== 0n
        ) {
          throw new CloneFallback("Source needs the legacy retention backend");
        }
        const destination = params.project(file);
        await prepareDirectory(path.dirname(destination));
        const sourceRoot = await openRoot(path.dirname(file), {
          hardlinks: "allow",
          symlinks: "reject",
          maxBytes: Number(expected.size),
        });
        let opened!: Awaited<ReturnType<Root["open"]>>;
        let clone!: BigIntStats;
        const assertSource = (current: BigIntStats) => {
          if (
            !current.isFile() ||
            !sameFileMutationFingerprint(expected, current) ||
            !sameFileMutationMetadata(expected, current)
          ) {
            throw new CloneFallback("Source changed during clone capture");
          }
        };
        await destinationRoot.copyIn(
          path.relative(params.targetStateDir, destination),
          {
            root: {
              open: async (...args: Parameters<Root["open"]>) => {
                opened = await sourceRoot.open(...args);
                try {
                  assertSource(fsSync.fstatSync(opened.handle.fd, { bigint: true }));
                } catch (error) {
                  await opened.handle.close();
                  throw error;
                }
                return opened;
              },
              stat: sourceRoot.stat.bind(sourceRoot),
            },
            relativePath: path.basename(file),
          },
          {
            clone: "always",
            overwrite: false,
            mkdir: false,
            durable: false,
            sourceHardlinks: "allow",
            sourceSymlinks: "reject",
            maxBytes: Number(expected.size),
            mode: Number(expected.mode & 0o7777n),
            onDestinationPublished: (receipt) => {
              assertSource(fsSync.fstatSync(opened.handle.fd, { bigint: true }));
              assertSource(fsSync.lstatSync(file, { bigint: true }));
              clone = fsSync.lstatSync(receipt.path, { bigint: true });
              if (
                !clone.isFile() ||
                clone.dev !== receipt.dev ||
                clone.ino !== receipt.ino ||
                (clone.dev === expected.dev && clone.ino === expected.ino) ||
                clone.size !== expected.size
              ) {
                throw new Error("Retained clone does not match its publication receipt");
              }
            },
          },
        );
        // Publication precedes fs-safe's final chmod; inventory the completed private file.
        clone = fsSync.lstatSync(destination, { bigint: true });
        if ((clone.mode & 0o7777n) !== (expected.mode & 0o7777n)) {
          throw new Error("Retained clone does not match its completed mode");
        }
        return {
          path: file,
          kind: "file",
          size: Number(clone.size),
          mode: Number(clone.mode & 0o7777n),
          dev: clone.dev.toString(),
          ino: clone.ino.toString(),
          birthtimeNs: clone.birthtimeNs.toString(),
          mtimeNs: clone.mtimeNs.toString(),
          ctimeNs: clone.ctimeNs.toString(),
          uid: clone.uid.toString(),
          gid: clone.gid.toString(),
        };
      })();
      captured.set(file, capturing);
    }
    return capturing;
  };
  const plan = await observeUpdateCandidatePluginTrees(params, {
    file: capture,
    capturedFile: (file) => captured.get(file),
    controlFile: async (file) => {
      if (captured.has(file)) {
        await captured.get(file);
        return params.project(file);
      }
      const stat = await fs.lstat(file, { bigint: true }).catch((error: unknown) => {
        if (hasNodeErrorCode(error, "ENOENT")) {
          return undefined;
        }
        throw error;
      });
      if (stat) {
        await capture(file, stat);
      }
      return params.project(file);
    },
  });
  const selected = new Set(plan.entries.map((entry) => entry.path));
  if ([...captured.keys()].some((file) => !selected.has(file))) {
    throw new CloneFallback("Captured controls require legacy graph materialization");
  }
  return { ...plan, captured: true as const };
}
