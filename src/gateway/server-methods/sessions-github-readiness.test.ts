import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getEnvironmentData, setEnvironmentData } from "node:worker_threads";
import { Value } from "typebox/value";
import { afterEach, assert, expect, it, vi } from "vitest";
import { SessionGitHubReadinessResultSchema } from "../../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as identity from "../../agents/github-tool-identity.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import * as gatewayTransport from "../../agents/tools/gateway.js";
import { createGitHubPublishTool } from "../../agents/tools/github-publish-tool.js";
import { runGit } from "../../agents/worktrees/git.js";
import { insertRegistryWorktree, updateRegistryWorktree } from "../../agents/worktrees/registry.js";
import { managedWorktrees } from "../../agents/worktrees/service.js";
import { makeWorktreeRecord } from "../../agents/worktrees/service.test-support.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import * as workerCpu from "../../infra/worker-cpu.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { holdStateRead } from "../../state/github-publication-fixtures.test-support.js";
import { repositoryRow } from "../../state/github-publication.worker.test-support.js";
import { unregisterOpenClawAgentDatabase } from "../../state/openclaw-agent-db-registry.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { ensureGitHubPublicationSchema } from "../../state/openclaw-state-db-schema-additive.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import * as oauth from "../github-oauth-lifecycle.js";
import { digestGitHubPublicationRequest } from "../github-publication-receipt.js";
import {
  claimGitHubPublicationExecutionFixture,
  createGitHubPublicationExecutionStoreFixture,
  insertRepositoryGitHubPublicationFixture,
} from "../github-publication-store.test-support.js";
import { insertGitHubPublicationRequest } from "../github-publication-store.worker.js";
import * as publicationTarget from "../github-publication-target.js";
import { createGitHubPublicationCoordinator } from "../github-publication.js";
import { repositoryGitHubPublicationDigest } from "../github-repository-publication.kernel.js";
import { handleGatewayRequest } from "../server-methods.js";
import { createContext } from "../server-plugin-in-process-dispatch.test-support.js";
import { createWorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import {
  sessionKey,
  sessionId,
  withReadFixture,
  type ReadFixture,
} from "./sessions-github-read.test-support.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
const githubOrigin = "https://github.com/example/project.git";
const unbound = {
  policy: { read: "admitted", write: "unknown" },
  custody: { kind: "unbound_workspace" },
  target: { kind: "unknown", reason: "not-qualified" },
  request: { kind: "none", selection: "current" },
};

async function fixture(
  run: (f: ReadFixture) => Promise<void>,
  options: Parameters<typeof withReadFixture>[1] = {},
) {
  await withReadFixture(async (f) => {
    Object.assign(f.context, createContext([], f.context.getRuntimeConfig));
    const service = createGitHubPublicationCoordinator({
      placements: createWorkerSessionPlacementStore(),
      getCommittedRuntimeConfig: f.context.getRuntimeConfig,
    });
    f.context.githubPublicationService = service;
    const forbidden = () => {
      throw new Error("Readiness attempted an external effect or credential preparation");
    };
    const effects = [
      vi.spyOn(service, "requestForSessionV2").mockImplementation(forbidden),
      vi.spyOn(service, "preparePersonalStatus").mockImplementation(forbidden),
      vi.spyOn(service, "personalPending").mockImplementation(forbidden),
      vi.spyOn(identity, "prepareGitHubPublicationIdentity").mockImplementation(forbidden),
      vi.spyOn(identity, "prepareGitHubPublicationOptionsIdentity").mockImplementation(forbidden),
      vi.spyOn(oauth, "requestCurrentGitHubOAuthRefresh").mockImplementation(forbidden),
      vi.spyOn(publicationTarget, "prepareGitHubPublicationTarget").mockImplementation(forbidden),
      vi.spyOn(gatewayTransport, "callGatewayTool").mockImplementation(forbidden),
    ];
    try {
      await run(f);
    } finally {
      for (const effect of effects) {
        expect(effect).not.toHaveBeenCalled();
        effect.mockRestore();
      }
      expect(f.personalConnectionStatus).not.toHaveBeenCalled();
    }
  }, options);
}

async function call(f: ReadFixture, params: Record<string, unknown> = {}, internal = false) {
  const respond = vi.fn<GatewayRequestHandlerOptions["respond"]>();
  await handleGatewayRequest({
    req: {
      type: "req",
      id: "readiness-rpc",
      method: "sessions.github.readiness",
      params: { sessionKey, ...params },
    },
    context: f.context,
    client: internal ? null : f.client,
    isWebchatConnect: () => false,
    respond,
  });
  expect(respond).toHaveBeenCalledOnce();
  return respond.mock.calls[0]!;
}
async function observe(f: ReadFixture, params: Record<string, unknown> = {}, internal = false) {
  const [ok, value, error] = await call(f, params, internal);
  assert(ok, JSON.stringify(error));
  assert(Value.Check(SessionGitHubReadinessResultSchema, value), JSON.stringify(value));
  return value;
}
async function tool(f: ReadFixture, input: Record<string, unknown>) {
  const publisher = createGitHubPublishTool();
  // Fixture precondition: supplied arguments satisfy the schema before direct execution.
  expect(Value.Check(publisher.parameters, input)).toBe(true);
  return withPluginRuntimeGatewayRequestScope(
    { context: f.context, client: f.client, isWebchatConnect: () => false },
    () =>
      withGatewayToolCallerIdentity(
        { agentId: "main", sessionKey, gatewayContextResolver: () => f.context },
        () => publisher.execute("readiness-observation", input),
      ),
  );
}
async function git(root: string, ...args: string[]) {
  const result = await runGit(root, args);
  assert(result.code === 0, result.stderr);
  return result.stdout.trim();
}
async function bind(origin = githubOrigin) {
  const root = await fs.realpath(temporary.make("readiness-git-"));
  await git(root, "init", "--initial-branch=feature");
  await git(root, "config", "user.name", "Publication Fixture");
  await git(root, "config", "user.email", "publication@example.invalid");
  await git(root, "config", "commit.gpgsign", "false");
  await git(root, "commit", "--allow-empty", "-m", "fixture");
  if (origin) await git(root, "remote", "add", "origin", origin);
  const repository = await managedWorktrees.resolveRepositoryIdentity(root);
  const worktree = makeWorktreeRecord(repository.repoRoot, randomUUID(), {
    path: root,
    repoFingerprint: repository.fingerprint,
    branch: "feature",
    ownerId: sessionKey,
  });
  await insertRegistryWorktree(process.env, worktree);
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey },
    {
      worktree: { id: worktree.id, branch: worktree.branch, repoRoot: worktree.repoRoot },
    },
  );
  return worktree;
}
function seed(worktree: Awaited<ReturnType<typeof bind>>, key = sessionKey) {
  ensureGitHubPublicationSchema(openOpenClawStateDatabase().db);
  const requestId = randomUUID();
  const request = { sessionKey: key, agentId: "main", idempotencyKey: requestId, draft: false };
  return runOpenClawStateWriteTransaction(({ db }) =>
    insertGitHubPublicationRequest(db, {
      request,
      requestId,
      requestDigest: digestGitHubPublicationRequest({ ...request, sessionId }),
      sessionId,
      lifecycleRevision: null,
      requester: { version: 1, actor: { kind: "system" }, scopes: ["operator.admin"], grant: null },
      assertCurrent() {},
      now: 1000,
      worktree,
      identity: {
        source: "system-configured",
        profileId: "fixture-profile",
        account: { accountId: 7, login: "fixture-bot", avatarUrl: null },
      },
    }),
  );
}
async function databaseArtifacts(additionalPaths: string[] = []) {
  const values: Record<string, string> = {};
  for (const pathname of [
    resolveOpenClawStateSqlitePath(),
    resolveOpenClawAgentSqlitePath({ agentId: "main" }),
    ...additionalPaths,
  ]) {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      try {
        values[pathname + suffix] = createHash("sha256")
          .update(await fs.readFile(pathname + suffix))
          .digest("hex");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
  }
  return values;
}
async function cold() {
  await closeOpenClawAgentDatabasesAsync();
  await closeStateDatabaseForTest();
}

it("observes an unbound source through the validated publisher and registered Gateway", async () => {
  await fixture(async (f) => {
    expect((await tool(f, { action: "readiness" })).details).toMatchObject(unbound);
  });
});
it("registers a separate source-qualified read for broad and internal operators", async () => {
  await fixture(async (f) => {
    for (const internal of [false, true])
      expect(await observe(f, {}, internal)).toMatchObject(unbound);
  });
});
it("qualifies real managed Git, retains cached freshness, and never stages files", async () => {
  await fixture(async (f) => {
    const worktree = await bind();
    await fs.writeFile(path.join(worktree.path, "unpublished.txt"), "preserve me");
    const head = await git(worktree.path, "rev-parse", "HEAD");
    const status = await git(worktree.path, "status", "--porcelain");
    const first = await observe(f);
    expect(first).toMatchObject({
      custody: { kind: "qualified", source: "worktree" },
      target: { kind: "supported", basis: "registered-repository", freshness: "observed" },
    });
    expect((await observe(f)).target).toMatchObject({ freshness: "cached" });
    expect(await git(worktree.path, "rev-parse", "HEAD")).toBe(head);
    expect(await git(worktree.path, "status", "--porcelain")).toBe(status);
    expect(await fs.readFile(path.join(worktree.path, "unpublished.txt"), "utf8")).toBe(
      "preserve me",
    );
    await updateRegistryWorktree(process.env, worktree.id, { removedAt: 2 });
    expect((await observe(f)).custody).toEqual({ kind: "changed" });
  });
});
it.each(["", "https://example.test/project.git"])(
  "distinguishes an unsupported origin %s from unbound custody",
  async (origin) => {
    await fixture(async (f) => {
      await bind(origin);
      expect(await observe(f)).toMatchObject({
        custody: { kind: "qualified", source: "worktree" },
        target: { kind: "unsupported" },
      });
    });
  },
);
it("reads current pending rows without a second request or settlement", async () => {
  await fixture(async (f) => {
    const worktree = await bind();
    const row = seed(worktree);
    expect((await observe(f)).request).toMatchObject({
      kind: "observed",
      selection: "current",
      receipt: { requestId: row.request_id, status: "requested" },
    });
    const before = await databaseArtifacts();
    const first = await observe(f, { requestId: row.request_id });
    expect(first.request).toMatchObject({
      kind: "observed",
      selection: "exact",
      receipt: { requestId: row.request_id, status: "requested" },
    });
    expect(first.remedies).toContainEqual({ kind: "observe_request", requestId: row.request_id });
    // Reobserving after a lost reply is the same read, not a new publication.
    expect((await observe(f, { requestId: row.request_id })).request).toEqual(first.request);
    expect(await databaseArtifacts()).toEqual(before);
    runOpenClawStateWriteTransaction(({ db }) =>
      db.exec("DELETE FROM github_publication_session_lifecycles"),
    );
    expect((await observe(f, { requestId: row.request_id })).request).toEqual({
      kind: "unknown",
      reason: "unavailable",
      selectedRequestId: row.request_id,
    });
  });
});
it("keeps exact terminal history when source is unavailable and excludes foreign receipts", async () => {
  await fixture(async (f) => {
    const worktree = await bind();
    const row = seed(worktree);
    const foreign = seed(worktree, "agent:main:foreign");
    const claimed = claimGitHubPublicationExecutionFixture(row.request_id, "readiness-fixture");
    createGitHubPublicationExecutionStoreFixture("readiness-fixture").complete(claimed, {
      requestId: row.request_id,
      status: "published",
      repository: "example/project",
      branch: worktree.branch,
      url: "https://github.com/example/project/pull/1",
      headCommit: "a".repeat(40),
    });
    vi.spyOn(managedWorktrees, "resolveRepositoryIdentity").mockRejectedValue(
      new Error("synthetic unavailable repository"),
    );
    expect(await observe(f, { requestId: row.request_id })).toMatchObject({
      custody: { kind: "unknown", reason: "unavailable" },
      request: {
        kind: "observed",
        selection: "exact",
        receipt: { requestId: row.request_id, status: "published" },
      },
    });
    expect((await observe(f, { requestId: foreign.request_id })).request).toEqual({
      kind: "unknown",
      reason: "not-observable",
      selectedRequestId: foreign.request_id,
    });
  });
});
it("observes repository-only shared receipts while personal receipts remain private", async () => {
  await fixture(
    async (f) => {
      const workspace = await getSessionRepositoryWorkspaceStore().create({
        agentId: "main",
        sessionKey,
        url: githubOrigin,
        branch: "feature",
        assertCurrent() {},
      });
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        { repositoryWorkspaceId: workspace.workspaceId },
      );
      const requestId = randomUUID();
      const row = {
        ...repositoryRow(requestId),
        session_id: sessionId,
        session_key: sessionKey,
        workspace_id: workspace.workspaceId,
        branch: workspace.branch,
        last_effect: "push",
        effect_state: "dispatched",
      };
      row.request_digest = repositoryGitHubPublicationDigest(row);
      insertRepositoryGitHubPublicationFixture(row, () => {});
      const personal = {
        ...row,
        request_id: randomUUID(),
        idempotency_key: randomUUID(),
        identity_source: "personal",
        owner_profile_id: "private-person",
        connection_generation: randomUUID(),
      };
      personal.request_digest = repositoryGitHubPublicationDigest(personal);
      insertRepositoryGitHubPublicationFixture(personal, () => {});
      expect(await observe(f)).toMatchObject({
        custody: { kind: "qualified", source: "repository" },
        target: { kind: "supported", basis: "repository-url" },
        request: {
          kind: "observed",
          receipt: { requestId, effect: { kind: "push", status: "dispatched" } },
        },
      });
      expect((await observe(f, { requestId })).remedies).toContainEqual({
        kind: "observe_request",
        requestId,
      });
      expect((await observe(f, { requestId: personal.request_id })).request).toEqual({
        kind: "unknown",
        reason: "not-observable",
        selectedRequestId: personal.request_id,
      });
    },
    { personal: true },
  );
});
it.each([false, true])(
  "preserves cold DB and sidecar names and bytes through full authority (profile=%s)",
  async (personal) => {
    await fixture(
      async (f) => {
        const workspace = await getSessionRepositoryWorkspaceStore().create({
          agentId: "main",
          sessionKey,
          url: githubOrigin,
          assertCurrent() {},
        });
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          { repositoryWorkspaceId: workspace.workspaceId },
        );
        await cold();
        const before = await databaseArtifacts();
        expect((await observe(f)).custody).toEqual({ kind: "qualified", source: "repository" });
        expect(await databaseArtifacts()).toEqual(before);
      },
      { personal },
    );
  },
);
it("keeps an absent shared database absent and does not manufacture an exact receipt", async () => {
  await fixture(async (f) => {
    await cold();
    const shared = resolveOpenClawStateSqlitePath();
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      await fs.rm(shared + suffix, { force: true });
    const before = await databaseArtifacts();
    const requestId = randomUUID();
    expect((await observe(f, { requestId })).request).toEqual({
      kind: "unknown",
      reason: "not-observable",
      selectedRequestId: requestId,
    });
    expect(await databaseArtifacts()).toEqual(before);
  });
});
it.each(["connection", "grant", "session", "visibility", "source"] as const)(
  "rejects post-await %s revocation instead of returning unknown",
  async (kind) => {
    await fixture(
      async (f) => {
        const grant = new AbortController();
        f.client.internal = {
          operatorAccessAuthority: {
            signal: grant.signal,
            assertCurrent: () => grant.signal.throwIfAborted(),
          },
        };
        // Reacquire agent authority from a private snapshot. The live profile catalog
        // keeps its existing shared-store admission for method-policy checks.
        await closeOpenClawAgentDatabasesAsync();
        const held = holdStateRead("githubPublications.sharedObservation");
        const pending = call(f);
        try {
          await awaitGateBeforeSettlement(
            held.ready,
            pending,
            "readiness returned before real receipt read",
          );
          if (kind === "connection") f.disconnect();
          else if (kind === "grant") grant.abort();
          else if (kind === "source") await closeOpenClawAgentDatabasesAsync();
          else if (kind === "visibility")
            await upsertSessionEntryCore({ agentId: "main", sessionKey }, { visibility: "draft" });
          else
            await upsertSessionEntryCore(
              { agentId: "main", sessionKey },
              { lifecycleRevision: randomUUID() },
            );
          held.release();
          expect((await pending)[0]).toBe(false);
        } finally {
          held.release();
          await pending;
          held.restore();
        }
      },
      {
        personal: true,
        scopes: ["operator.sessions.read"],
        others: "view",
        foreign: kind === "visibility",
      },
    );
  },
);
it("rejects incompatible fields and pending authentication without starting refresh", async () => {
  await fixture(async (f) => {
    for (const params of [
      { workspacePath: "/never-adopt" },
      { idempotencyKey: "never-allocate" },
      { selection: { source: "personal" } },
    ]) {
      expect((await call(f, params))[0]).toBe(false);
    }
    await expect(tool(f, { action: "readiness", title: "never publish" })).rejects.toThrow(
      "readiness accepts only",
    );
    const sync = vi.fn(async () => {
      throw new Error("Observation must not refresh login");
    });
    f.client.authenticatedGitHubIdentitySync = sync;
    f.client.authenticatedUserProfile = undefined;
    expect((await call(f))[0]).toBe(false);
    expect(sync).not.toHaveBeenCalled();
  });
});

it("distinguishes prepared imports, incomplete imports, archived and missing custody", async () => {
  await fixture(async (f) => {
    const worktree = await bind();
    const head = await git(worktree.path, "rev-parse", "HEAD");
    const binding = {
      url: "https://github.com/example/project/pull/7",
      host: "github.com",
      number: 7,
      base: { repository: "example/project", repositoryId: 1, branch: "main", commit: head },
      head: { repository: "example/project", repositoryId: 1, branch: "feature", commit: head },
    };
    const selected = { id: worktree.id, branch: worktree.branch, repoRoot: worktree.repoRoot };
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      {
        worktree: { ...selected, githubPullRequest: binding },
      },
    );
    expect((await observe(f)).custody).toEqual({ kind: "changed" });
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      {
        worktree: { ...selected, githubPullRequest: { ...binding, preparedHeadCommit: head } },
      },
    );
    expect(await observe(f)).toMatchObject({
      custody: { kind: "qualified", source: "imported-pr" },
      target: { kind: "supported", basis: "prepared-imported-pr", freshness: "observed" },
    });
    await upsertSessionEntryCore({ agentId: "main", sessionKey }, { archivedAt: 100 });
    expect((await observe(f)).custody).toEqual({ kind: "archived" });
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      {
        archivedAt: undefined,
        worktree: { ...selected, id: randomUUID() },
      },
    );
    expect((await observe(f)).custody).toEqual({ kind: "changed" });
  });
});

it("keeps wrong repository ownership distinct from a genuinely unbound workspace", async () => {
  await fixture(async (f) => {
    const workspace = await getSessionRepositoryWorkspaceStore().create({
      agentId: "main",
      sessionKey: "agent:main:another-owner",
      url: githubOrigin,
      assertCurrent() {},
    });
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      { repositoryWorkspaceId: workspace.workspaceId },
    );
    expect((await observe(f)).custody).toEqual({ kind: "changed" });
  });
});

it("selects only a child publication session through the actual tool", async () => {
  await fixture(async (f) => {
    const child = "agent:main:readiness-child";
    const unrelated = "agent:main:readiness-unrelated";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: child },
      {
        sessionId: randomUUID(),
        updatedAt: 1,
        parentSessionKey: sessionKey,
      },
    );
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: unrelated },
      { sessionId: randomUUID(), updatedAt: 1 },
    );
    await cold();
    const before = await databaseArtifacts();
    expect(
      (await tool(f, { action: "readiness", publishingSessionKey: child })).details,
    ).toMatchObject(unbound);
    await expect(tool(f, { action: "readiness", publishingSessionKey: unrelated })).rejects.toThrow(
      /not a child/,
    );
    expect(await databaseArtifacts()).toEqual(before);
  });
});

it("keeps native read denial ahead of source or receipt observation", async () => {
  await fixture(
    async (f) => {
      const receiptRead = vi.spyOn(f.context.githubPublicationService!, "latestShared");
      expect((await call(f))[0]).toBe(false);
      expect(receiptRead).not.toHaveBeenCalled();
    },
    { personal: true, scopes: [] },
  );
});

it.each(["custom.json", "shared.sqlite"])(
  "preserves cold configured locator %s without registry ownership",
  async (name) => {
    await fixture(async (f) => {
      const root = await fs.realpath(temporary.make("readiness-locator-"));
      const storePath = path.join(root, name);
      const databasePath = path.join(root, name.replace(/\.json$/, ".sqlite"));
      const config = f.context.getRuntimeConfig();
      setRuntimeConfigSnapshot({ ...config, session: { ...config.session, store: storePath } });
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey, storePath },
        { sessionId, updatedAt: 1 },
      );
      // A registered control proves the configured source reaches the real read surface.
      expect(await observe(f)).toMatchObject(unbound);
      await cold();
      unregisterOpenClawAgentDatabase({ agentId: "main", path: databasePath });
      await cold();
      const before = await databaseArtifacts([databasePath]);
      expect(before).toHaveProperty(databasePath);
      expect(before[databasePath + "-wal"]).toBeUndefined();
      expect(before[databasePath + "-shm"]).toBeUndefined();
      const counts = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2));
      const create = workerCpu.createCpuTrackedWorker;
      const observer = vi
        .spyOn(workerCpu, "createCpuTrackedWorker")
        .mockImplementation((filename, options) => {
          if (options?.eval) return create(filename, options);
          const entry = typeof filename === "string" ? pathToFileURL(filename) : filename;
          const key = "openclaw.test.readinessNativeReads";
          const previous = getEnvironmentData(key);
          setEnvironmentData(key, {
            entry: entry.href,
            source: databasePath,
            counts: counts.buffer,
          });
          try {
            return create(
              new URL("./sessions-github-readiness.native.test-support.mjs", import.meta.url),
              options,
            );
          } finally {
            setEnvironmentData(key, previous);
          }
        });
      try {
        expect(await observe(f)).toMatchObject(unbound);
        expect(await databaseArtifacts([databasePath])).toEqual(before);
        expect(
          Atomics.load(counts, 0),
          "real worker SQLite opens must be observed",
        ).toBeGreaterThan(0);
        expect(Atomics.load(counts, 1), "readiness must open private images, not the source").toBe(
          0,
        );
      } finally {
        observer.mockRestore();
      }
    });
  },
);

it.each(["requested", "publishing", "published", "failed"] as const)(
  "projects only readiness facts from a real %s receipt",
  async (status) => {
    await fixture(async (f) => {
      const worktree = await bind();
      const row = seed(worktree);
      const details =
        status === "published"
          ? {
              url: "https://github.com/example/project/pull/1",
              repository: "example/project",
              branch: worktree.branch,
              headCommit: "a".repeat(40),
            }
          : status === "failed"
            ? { code: "unavailable" as const }
            : {};
      if (status !== "requested") {
        const claim = claimGitHubPublicationExecutionFixture(row.request_id, "projection-fixture");
        const store = createGitHubPublicationExecutionStoreFixture("projection-fixture");
        if (status === "published")
          store.complete(claim, {
            requestId: row.request_id,
            status,
            url: "https://github.com/example/project/pull/1",
            repository: "example/project",
            branch: worktree.branch,
            headCommit: "a".repeat(40),
          });
        else if (status === "failed")
          store.complete(claim, {
            requestId: row.request_id,
            status,
            code: "unavailable",
            message: "Private failure detail",
            nextAction: "Private recovery action",
          });
      }
      expect((await observe(f, { requestId: row.request_id })).request).toEqual({
        kind: "observed",
        selection: "exact",
        receipt: { requestId: row.request_id, status, ...details },
      });
    });
  },
);
