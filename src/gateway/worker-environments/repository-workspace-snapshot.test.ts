import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { captureRepositoryDiskCheckpoint } from "./repository-workspace-snapshot.js";
import { withSessionRepositoryCheckpoint } from "./session-repository-checkpoints.js";
import { sessionTarget } from "./worker-turn-launcher.test-support.js";
import { requireWorkspaceResultGit } from "./workspace-result-git.js";
import { useRepositoryWorkspaceResultFixture } from "./workspace-result-repository.test-support.js";
import {
  hasWorkerWorkspaceResultRef,
  workerWorkspaceResultRef,
} from "./workspace-result-staging.js";

// mock-isolation: Real node/Git/HTTP transfer uses a local origin with no GitHub credentials.
vi.mock("./repository-github-identity.js", () => ({
  prepareRepositoryGitHubIdentity: async (_agentId: string, assertCurrent: () => void) => ({
    token: undefined,
    assertSelected: assertCurrent,
    start: async (start: () => Promise<unknown>) => await start(),
  }),
}));
const { fixture } = useRepositoryWorkspaceResultFixture();

it.each(["replacement", "revoked"] as const)(
  "rejects %s disk capture before workspace effects",
  async (condition) => {
    const f = await fixture("worker-turn");
    const repository = await f.bindDisk();
    assert(repository.diskAuthority);
    const original = f.environments.get(repository.diskAuthority.environmentId);
    assert(original?.state === "attached");
    const quiesce = vi.spyOn(f.tunnel, "quiesceWorkspace");
    const upload = vi.spyOn(f.workspaceTransfer, "prepareUpload");
    let current = true;
    if (condition === "replacement") {
      vi.mocked(f.environments.get).mockReturnValue({
        ...original,
        resourceReceipt: {
          ...repository.diskAuthority.resourceReceipt,
          identity: { diskId: "another-disk" },
        },
      });
    } else {
      vi.mocked(f.environments.startTunnel).mockImplementation(async () => {
        await Promise.resolve();
        current = false;
        return f.tunnel;
      });
    }
    const checkpointRef = workerWorkspaceResultRef(`refused-${condition}`);
    const consume = vi.fn(async () => {});
    await expect(
      captureRepositoryDiskCheckpoint(
        {
          identity: sessionTarget,
          repository,
          checkpointRef,
          purpose: "publication",
          placements: f.placements,
          environments: f.environments,
          assertCurrent() {
            if (!current) {
              throw new Error("request revoked");
            }
          },
        },
        consume,
      ),
    ).rejects.toThrow(
      condition === "replacement" ? "disk is missing or changed" : "request revoked",
    );
    expect(quiesce).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
    expect(
      await hasWorkerWorkspaceResultRef({
        root: f.store.artifactPath(repository.workspaceId),
        stagedResultRef: checkpointRef,
      }),
    ).toBe(false);
    expect(await f.store.get(repository.workspaceId)).toEqual(repository);
  },
);

it("exports current private history and files, then fences a late source edit before handoff", async () => {
  const f = await fixture("worker-turn");
  const repository = await f.bindDisk();
  await f.write("committed.txt", "private committed bytes\n");
  await requireWorkspaceResultGit(f.remote, ["add", "committed.txt"]);
  await requireWorkspaceResultGit(f.remote, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-m",
    "private node history",
  ]);
  const head = await requireWorkspaceResultGit(f.remote, ["rev-parse", "HEAD"]);
  await f.write("working.txt", "current uncommitted bytes\n");
  const quiescence = await f.tunnel.quiesceWorkspace(f.remote);
  try {
    await captureRepositoryDiskCheckpoint(
      {
        identity: sessionTarget,
        repository,
        checkpointRef: workerWorkspaceResultRef("fresh-export"),
        purpose: "gateway-move",
        quiescence,
        placements: f.placements,
        environments: f.environments,
        assertCurrent() {},
      },
      async (snapshot, verifyCurrent) => {
        await withSessionRepositoryCheckpoint(
          { workspaceId: repository.workspaceId, checkpointRef: snapshot.checkpointRef },
          async (payload) => {
            expect(payload.gitHistory).toMatchObject({ headCommit: head, descendsFromBase: true });
            expect(payload.gitHistoryNote).toBeUndefined();
            expect(await fs.readFile(path.join(payload.stagingRoot, "working.txt"), "utf8")).toBe(
              "current uncommitted bytes\n",
            );
          },
        );
        await verifyCurrent();
        await f.write("working.txt", "changed after export selection\n");
        await expect(verifyCurrent()).rejects.toThrow("changed during checkpoint capture");
      },
    );
  } finally {
    await quiescence.resume();
  }
  expect(await f.store.get(repository.workspaceId)).toEqual(repository);
  expect(await requireWorkspaceResultGit(f.remote, ["rev-parse", "HEAD"])).toBe(head);
});

it("refuses a lossy staged-index export while retaining the original disk", async () => {
  const f = await fixture("worker-turn");
  const repository = await f.bindDisk();
  await f.write("partial.txt", "staged-only content\n");
  await requireWorkspaceResultGit(f.remote, ["add", "partial.txt"]);
  await f.write("partial.txt", "different working content\n");
  const upload = vi.spyOn(f.workspaceTransfer, "prepareUpload");
  const quiescence = await f.tunnel.quiesceWorkspace(f.remote);
  try {
    await expect(
      captureRepositoryDiskCheckpoint(
        {
          identity: sessionTarget,
          repository,
          checkpointRef: workerWorkspaceResultRef("partial-export"),
          purpose: "gateway-move",
          quiescence,
          placements: f.placements,
          environments: f.environments,
          assertCurrent() {},
        },
        async () => {},
      ),
    ).rejects.toThrow("resolve staged changes");
  } finally {
    await quiescence.resume();
  }
  expect(upload).not.toHaveBeenCalled();
  expect(await requireWorkspaceResultGit(f.remote, ["show", ":partial.txt"])).toBe(
    "staged-only content",
  );
  expect(await fs.readFile(path.join(f.remote, "partial.txt"), "utf8")).toBe(
    "different working content\n",
  );
  expect(await f.store.get(repository.workspaceId)).toEqual(repository);
});
