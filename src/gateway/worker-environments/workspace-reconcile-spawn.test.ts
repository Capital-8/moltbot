import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { BrokerChild } from "../../process/spawn-broker/child.js";
import { runWithSpawnBroker } from "../../process/spawn-broker/context.js";
import { createSpawnBrokerHost } from "../../process/spawn-broker/host.js";
import { supportsSpawnBrokerCommandTransport } from "../../process/spawn-broker/pipe.js";
import * as diagnostics from "../../process/spawn-diagnostics.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import { sha256 } from "./workspace-manifest-fixtures.test-support.js";
import { serializeWorkerWorkspaceManifest } from "./workspace-manifest.js";
import { applyWorkspacePatch, createWorkspacePatch } from "./workspace-reconcile-recovery.js";
import {
  expectWorkspaceFiles,
  manifestFor,
  writeWorkspaceFiles,
} from "./workspace-recovery.test-support.js";
import {
  readStagedWorkerWorkspaceResult,
  workerWorkspaceResultStaging,
} from "./workspace-result-staging.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  vi.restoreAllMocks();
  await drainGlobalSingletonLifecycleState();
});

it.skipIf(!supportsSpawnBrokerCommandTransport())(
  "reconciles and stages exact bytes without native Gateway Git launches",
  async () => {
    const root = tempDirs.make("workspace-spawn-base-");
    const stagingRoot = tempDirs.make("workspace-spawn-current-");
    const oldFiles = { binary: Buffer.from([0, 255, 13, 10]), removed: "old\n" };
    const newFiles = { binary: Buffer.from([255, 0, 10, 13]), "new ü": "new\r\n" };
    await writeWorkspaceFiles(root, oldFiles);
    await writeWorkspaceFiles(stagingRoot, newFiles);
    const base = await manifestFor(root);
    const current = await manifestFor(stagingRoot);
    const host = createSpawnBrokerHost();
    await host.ready();
    try {
      const launches = vi.spyOn(diagnostics, "recordChildProcessSpawn");
      await runWithSpawnBroker(host, async () => {
        const snapshot = await createWorkspacePatch({
          root,
          stagingRoot,
          baseEntries: base.entries,
          appliedEntries: current.entries,
        });
        await applyWorkspacePatch({ root, patch: snapshot.patch });
        await expectWorkspaceFiles(root, newFiles);
        await expect(fs.stat(path.join(root, "removed"))).rejects.toMatchObject({ code: "ENOENT" });
        const stagedResultRef = "refs/openclaw/worker-results/spawn-proof";
        await workerWorkspaceResultStaging.stageWorkerWorkspaceResult({
          root,
          stagingRoot,
          stagedResultRef,
          baseManifestRef: `sha256:${sha256(serializeWorkerWorkspaceManifest(base))}`,
          currentManifestRef: `sha256:${sha256(serializeWorkerWorkspaceManifest(current))}`,
          baseManifestRaw: serializeWorkerWorkspaceManifest(base),
          currentManifestRaw: serializeWorkerWorkspaceManifest(current),
        });
        const staged = await readStagedWorkerWorkspaceResult(root, stagedResultRef);
        expect(staged.current).toEqual(current);
        for await (const { entry, content } of staged.readEntries()) {
          expect(content).toEqual(
            Uint8Array.from(Buffer.from(newFiles[entry.path as keyof typeof newFiles])),
          );
        }
      });
      const git = launches.mock.calls.filter(([command]) => path.basename(command) === "git");
      expect(git.length).toBeGreaterThan(0);
      expect(git.filter(([, child]) => !(child instanceof BrokerChild)).length).toBe(0);
    } finally {
      await host.close();
    }
  },
);
