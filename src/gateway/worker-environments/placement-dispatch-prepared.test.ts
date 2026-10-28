import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createGitHubReadIdentity } from "../../agents/github-read-identity.js";
import { getRuntimeConfig } from "../../config/config.js";
import {
  areDiagnosticsEnabledForProcess,
  setDiagnosticsEnabledForProcess,
} from "../../infra/diagnostic-events.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { sessionLog } from "../session-log.js";
import type { EnvironmentRecipe } from "./environment-recipe.js";
import { preparedHarness, FEATURES } from "./placement-dispatch-prepared.test-support.js";
import { REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { repository as createFixtureRepository } from "./provider-lifecycle.test-support.js";
import { prepareRepositoryGitHubIdentity } from "./repository-github-identity.js";
import * as support from "./service.test-support.js";
import {
  readSessionRepositoryArtifacts,
  stageSessionRepositoryCheckpoint,
} from "./session-repository-checkpoints.js";
import { captureWorkspaceManifest } from "./workspace-manifest-worker.js";
import { serializeWorkerWorkspaceManifest } from "./workspace-manifest.js";

// mock-isolation: Workspace startup supplies a synthetic identity without credential discovery.
vi.mock("./repository-github-identity.js", () => ({ prepareRepositoryGitHubIdentity: vi.fn() }));

vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  getRuntimeConfig: vi.fn(() => ({
    gateway: { nodes: { commands: { allow: ["codex.exec-server.stdio.v1"] } } },
  })),
}));

describe("prepared worker dispatch", () => {
  support.setupWorkerEnvironmentServiceSuite();

  const lifecycleRecipe: EnvironmentRecipe = {
    source: "devcontainer",
    identity: "8".repeat(40),
    inputs: { ".devcontainer/devcontainer.json": "8".repeat(40) },
    env: {},
    postCreate: ["post-create"],
    postStart: ["post-start"],
  };

  it.each([true, false])(
    "runs first-binding lifecycle after session sync and before activation (reserve=%s)",
    async (reserve) => {
      const { harness, request, ready } = await preparedHarness({
        reserve,
        recipe: lifecycleRecipe,
      });
      const previousDiagnostics = areDiagnosticsEnabledForProcess();
      setDiagnosticsEnabledForProcess(true);
      onTestFinished(() => {
        setDiagnosticsEnabledForProcess(previousDiagnostics);
        vi.restoreAllMocks();
      });
      vi.spyOn(sessionLog, "isEnabled").mockReturnValue(true);
      const warn = vi.spyOn(sessionLog, "warn").mockImplementation(() => {
        throw new Error("diagnostic sink unavailable");
      });
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      const attach = vi.mocked(harness.environments.attachSession);
      const ordinaryAttach = attach.getMockImplementation()!;
      attach.mockImplementation(async (params) => {
        const credential = await ordinaryAttach(params);
        now += 1_200;
        return credential;
      });
      if (!reserve) {
        const provision = vi.mocked(harness.environments.createWithRequest);
        const environment = harness.environments.get(ready.environmentId)!;
        provision.mockImplementation(async () => {
          now += 600;
          return environment;
        });
      }

      const active = await harness.service.dispatch(request);

      expect(active.state).toBe("active");
      expect(warn).toHaveBeenCalledExactlyOnceWith("slow placement dispatch", {
        operation: "sessions.dispatch",
        elapsedMs: reserve ? 1_200 : 1_800,
        phaseDurationsMs: {
          admission: 0,
          workspacePreparation: 0,
          reserveClaim: 0,
          ...(!reserve ? { provision: 600 } : {}),
          attach: 1_200,
          tunnel: 0,
          bind: 0,
          repositoryStartup: 0,
          lifecycleCommands: 0,
          activation: 0,
          cleanup: 0,
        },
      });
      expect(
        harness.log.filter((phase) =>
          [
            "workspace:bind-prepared",
            "sync",
            "lifecycle:post-create",
            "lifecycle:post-start",
            "placement:starting",
            "activation",
          ].includes(phase),
        ),
      ).toEqual([
        "workspace:bind-prepared",
        "sync",
        "lifecycle:post-create",
        "lifecycle:post-start",
        "placement:starting",
        "activation",
      ]);
      const tunnel = await vi.mocked(harness.environments.startTunnel).mock.results[0]!.value;
      expect(tunnel.launchTurn).not.toHaveBeenCalled();
    },
  );

  it("carries prepared repository authority into the provider lifecycle launch", async () => {
    const { harness, request } = await preparedHarness({ recipe: lifecycleRecipe });
    let repositoryCurrent = true;
    const bind = vi.mocked(harness.environments.bindPreparedWorkspace);
    const ordinaryBind = bind.getMockImplementation()!;
    bind.mockImplementation(async (input) => ({
      ...(await ordinaryBind(input)),
      assertCurrent: () => {
        input.assertCurrent();
        if (!repositoryCurrent) {
          throw new Error("Repository identity revoked");
        }
      },
    }));
    const runSetup = vi.fn<NonNullable<typeof harness.environments.runProjectLifecycleCommand>>(
      async (_environmentId, _ownerEpoch, command) => {
        expect(command.workspaceDir).toBe("/worker/workspace");
        expect(command.homeDir).toBe("/worker/home");
        command.assertCurrent();
        await Promise.resolve();
        repositoryCurrent = false;
        command.assertCurrent();
        throw new Error("Repository command must not launch");
      },
    );
    harness.environments.runProjectLifecycleCommand = runSetup;
    await expect(harness.service.dispatch(request)).rejects.toThrow("Repository identity revoked");
    expect(runSetup).toHaveBeenCalledOnce();
    expect(harness.log).not.toContain("lifecycle:post-create");
    expect(harness.log).not.toContain("activation");
  });

  it("fails dispatch before activation when a declared post-binding command fails", async () => {
    const { harness, placements, ready, request } = await preparedHarness({
      recipe: lifecycleRecipe,
      lifecycleFailure: true,
    });

    await expect(harness.service.dispatch(request)).rejects.toThrow("fixture failure");

    expect(harness.log).toContain("lifecycle:post-create");
    expect(harness.log).not.toContain("lifecycle:post-start");
    expect(harness.log).not.toContain("activation");
    expect(placements.get(request.sessionId)?.state).toBe("failed");
    expect(harness.environments.destroy).toHaveBeenCalledWith(ready.environmentId);
  });

  it.each(
    (["worker-turn", "remote-exec"] as const).flatMap((executionMode) =>
      [false, true].map((emptyWorkspace) => ({ executionMode, emptyWorkspace })),
    ),
  )(
    "consumes the existing environment for $executionMode (empty workspace: $emptyWorkspace)",
    async ({ executionMode, emptyWorkspace }) => {
      const { harness, placements, store, ready, request } = await preparedHarness({
        executionMode,
        emptyWorkspace,
      });
      vi.mocked(harness.environments.schedulePreparedRefill).mockImplementation(() => {
        expect(placements.get(request.sessionId)?.state).toBe("active");
        throw new Error("refill scheduling failed");
      });

      const active = await harness.service.dispatch(request);

      expect(active).toMatchObject({
        state: "active",
        environmentId: ready.environmentId,
        executionMode,
      });
      expect(harness.environments.createWithRequest).not.toHaveBeenCalled();
      expect(store.get(ready.environmentId)?.preparation?.consumedAtMs).toBe(1_000);
      expect(store.get(ready.environmentId)?.lastActivatedAtMs).toBe(1_000);
      expect(store.getCredential(ready.environmentId)).toMatchObject({
        sessionId: request.sessionId,
        ownerEpoch: active.activeOwnerEpoch,
      });
      if (emptyWorkspace) {
        expect(harness.environments.bindPreparedWorkspace).not.toHaveBeenCalled();
      } else {
        expect(harness.log.indexOf("workspace:bind-prepared")).toBeLessThan(
          harness.log.indexOf("sync"),
        );
      }
      expect(harness.environments.schedulePreparedRefill).toHaveBeenCalledWith(ready.environmentId);
      const tunnel = await vi.mocked(harness.environments.startTunnel).mock.results[0]?.value;
      expect(tunnel?.syncWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: request.sessionKey,
          source: {
            kind: "local",
            path: "/gateway/workspace",
            ...(emptyWorkspace ? {} : { projectKey: "d".repeat(64) }),
          },
        }),
      );
    },
  );

  it("binds a freshly prepared cold workspace without turning its ordinary row into a reserve", async () => {
    const { harness, store, ready, intent, request } = await preparedHarness({ reserve: false });

    const active = await harness.service.dispatch(request);

    expect(active.environmentId).toBe(ready.environmentId);
    expect(harness.environments.createWithRequest).toHaveBeenCalledWith({
      profileId: request.profileId,
      idempotencyKey: expect.any(String),
      executionMode: request.executionMode,
      projectPath: "/gateway/workspace",
      admittedIntent: intent,
    });
    expect(store.get(ready.environmentId)?.preparation).toBeNull();
    expect(harness.environments.bindPreparedWorkspace).toHaveBeenCalledOnce();
    expect(harness.log.indexOf("workspace:bind-prepared")).toBeLessThan(
      harness.log.indexOf("sync"),
    );
  });

  it.each(["build", "node", "exec-authority"] as const)(
    "uses the cold path when a candidate's %s proof is stale",
    async (stale) => {
      const { harness, store, ready, request, revokeNode } = await preparedHarness({
        protocolFeatures:
          stale === "exec-authority" ? [WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE] : undefined,
      });
      if (stale === "build") {
        const environment = harness.environments.get(ready.environmentId)!;
        vi.mocked(harness.environments.getPreparedCandidates).mockReturnValue([
          {
            ...environment,
            bootstrapReceipt: { ...ready.bootstrapReceipt!, bundleHash: "9".repeat(64) },
          },
        ]);
      } else if (stale === "node") {
        revokeNode();
      }

      const active = await harness.service.dispatch(request);

      expect(active.environmentId).toBe(harness.ready.environmentId);
      expect(active.environmentId).not.toBe(ready.environmentId);
      expect(harness.environments.createWithRequest).toHaveBeenCalledOnce();
      expect(store.get(ready.environmentId)?.preparation?.consumedAtMs).toBeNull();
      expect(harness.environments.bindPreparedWorkspace).not.toHaveBeenCalled();
    },
  );

  it.each([
    { executionMode: "worker-turn", reconnect: false },
    { executionMode: "remote-exec", reconnect: false },
    { executionMode: "worker-turn", reconnect: true },
    { executionMode: "remote-exec", reconnect: true },
  ] as const)(
    "keeps a $executionMode reserve unconsumed after session hosting is disabled (reconnect=$reconnect)",
    async ({ executionMode, reconnect }) => {
      const { harness, store, ready, request, setHostingAvailable } = await preparedHarness({
        executionMode,
      });
      setHostingAvailable(false, reconnect);

      const active = await harness.service.dispatch(request);

      expect(active.environmentId).toBe(harness.ready.environmentId);
      expect(harness.environments.createWithRequest).toHaveBeenCalledOnce();
      expect(store.get(ready.environmentId)?.preparation?.consumedAtMs).toBeNull();
      expect(store.getCredential(ready.environmentId)?.sessionId).toBeNull();
      expect(harness.environments.bindPreparedWorkspace).not.toHaveBeenCalled();
    },
  );

  it.each(["worker-turn", "remote-exec"] as const)(
    "does not consume a %s reserve when session hosting is disabled during admission",
    async (executionMode) => {
      const {
        harness,
        store,
        ready,
        request,
        transport,
        resolveAvailability,
        setHostingAvailable,
      } = await preparedHarness({ executionMode });
      const admitted = createDeferred();
      const release = createDeferred();
      resolveAvailability.mockImplementationOnce(async () => {
        const [node] = await transport.listCurrentNodes();
        admitted.resolve();
        await release.promise;
        return { available: true, node };
      });
      const dispatch = harness.service.dispatch(request);
      try {
        await admitted.promise;
        setHostingAvailable(false);
        release.resolve();
        const active = await dispatch;

        expect(active.environmentId).toBe(harness.ready.environmentId);
        expect(harness.environments.createWithRequest).toHaveBeenCalledOnce();
        expect(store.get(ready.environmentId)?.preparation?.consumedAtMs).toBeNull();
        expect(store.getCredential(ready.environmentId)?.sessionId).toBeNull();
        expect(harness.environments.bindPreparedWorkspace).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await dispatch;
      }
    },
  );

  it("does not mint attachment authority after request revocation during build validation", async () => {
    const { harness, store, ready, request } = await preparedHarness();
    let authorized = true;
    vi.mocked(support.testState.prepareInstallation).mockImplementation(async () => {
      authorized = false;
      return { ...support.BUNDLE_ARTIFACT, protocolFeatures: FEATURES };
    });

    await expect(
      harness.service.dispatch(request, undefined, () => {
        if (!authorized) {
          throw new Error("request revoked");
        }
      }),
    ).rejects.toThrow("request revoked");

    expect(store.get(ready.environmentId)?.preparation?.consumedAtMs).toBe(1_000);
    expect(harness.environments.startTunnel).not.toHaveBeenCalled();
    expect(harness.environments.destroy).toHaveBeenCalledWith(ready.environmentId);
  });

  it("rejects direct attachment without the prepared placement reservation", async () => {
    const { store, workerService, ready, request } = await preparedHarness();

    await expect(
      workerService.attachSession({
        environmentId: ready.environmentId,
        ownerEpoch: ready.ownerEpoch,
        sessionId: request.sessionId,
      }),
    ).rejects.toThrow("placement reservation");

    expect(store.get(ready.environmentId)).toMatchObject({
      state: "ready",
      preparation: { consumedAtMs: null },
    });
    expect(store.getCredential(ready.environmentId)?.sessionId).toBeNull();
  });

  it("fences a profile change after node eligibility before consuming its reserve", async () => {
    const { harness, store, ready, request } = await preparedHarness();
    vi.mocked(harness.environments.assertPreparedIntentCurrent)
      .mockImplementationOnce(() => {})
      .mockImplementation(() => {
        throw new Error("profile changed");
      });

    await expect(harness.service.dispatch(request)).rejects.toThrow("profile changed");

    expect(store.get(ready.environmentId)?.preparation?.consumedAtMs).toBeNull();
    expect(harness.environments.attachSession).not.toHaveBeenCalled();
    expect(harness.environments.createWithRequest).not.toHaveBeenCalled();
  });

  it("fences workspace upload when node authority closes during prepared binding", async () => {
    const { harness, store, ready, request, revokeNode } = await preparedHarness();
    const bind = vi.mocked(harness.environments.bindPreparedWorkspace);
    const ordinaryBind = bind.getMockImplementation()!;
    bind.mockImplementation(async (binding) => {
      const prepared = await ordinaryBind(binding);
      revokeNode();
      return prepared;
    });

    await expect(harness.service.dispatch(request)).rejects.toThrow("node authority");

    expect(harness.log).not.toContain("sync");
    expect(store.get(ready.environmentId)?.preparation?.consumedAtMs).toBe(1_000);
    expect(harness.environments.destroy).toHaveBeenCalledWith(ready.environmentId);
    expect(harness.environments.schedulePreparedRefill).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "keeps Repository integration admission outside its image reserve (reader present: %s)",
    async (hasReader) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", support.testState.root);
      integrationState.enabled = true;
      const originalConfig = getRuntimeConfig();
      vi.mocked(getRuntimeConfig).mockReturnValue({
        ...originalConfig,
        tools: {
          github: {
            kind: "app-installation",
            profileId: "ghp_6128c113c0df8c1a366dfe690c062d8e",
            app: {
              appId: 10,
              installationId: 20,
              accountId: 30,
              repositories: [{ id: 40, fullName: "example/project" }],
              permissions: { contents: "write" },
              privateKey: "synthetic-unreachable-key",
              keyVersion: "synthetic-v1",
            },
          },
        },
      });
      onTestFinished(() => {
        vi.unstubAllEnvs();
        vi.mocked(getRuntimeConfig).mockReturnValue(originalConfig);
      });
      const repository = await getSessionRepositoryWorkspaceStore().create({
        agentId: REQUEST.agentId,
        sessionKey: REQUEST.sessionKey,
        url: "https://github.com/example/project.git",
        runSetupScript: false,
        assertCurrent: () => {},
      });
      const { harness, store, ready, request } = await preparedHarness({
        repository,
        imageReserve: true,
      });
      const readNativeCredential = vi.fn(async () => {
        expect(store.get(ready.environmentId)?.attachedSessionIds).toEqual([request.sessionId]);
        expect(harness.environments.bindPreparedWorkspace).not.toHaveBeenCalled();
        throw new Error("current actor repository admission denied");
      });
      await expect(
        harness.service.dispatch({ ...request, ...(hasReader ? { readNativeCredential } : {}) }),
      ).rejects.toThrow(
        hasReader
          ? "current actor repository admission denied"
          : "current GitHub dispatch admission",
      );
      expect(harness.environments.createWithRequest).not.toHaveBeenCalled();
      if (!hasReader) {
        expect(harness.environments.prepareProjectIntent).not.toHaveBeenCalled();
        expect(store.get(ready.environmentId)?.preparation?.consumedAtMs).toBeNull();
        expect(readNativeCredential).not.toHaveBeenCalled();
      } else {
        expect(harness.environments.prepareProjectIntent).toHaveBeenCalledWith(request.profileId, {
          imageReserve: true,
          machineClass: undefined,
          executionMode: request.executionMode,
          inherited: undefined,
          signal: undefined,
          os: undefined,
        });
        expect(readNativeCredential).toHaveBeenCalledOnce();
        expect(store.get(ready.environmentId)?.preparation?.consumedAtMs).toBe(1_000);
        expect(harness.environments.destroy).toHaveBeenCalledWith(ready.environmentId);
        expect(harness.environments.schedulePreparedRefill).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    { runSetupScript: true, missingCheckpointOwner: false },
    { runSetupScript: false, missingCheckpointOwner: false },
    { runSetupScript: false, missingCheckpointOwner: true },
  ])(
    "claims a repository-only reserve (setup=$runSetupScript, missing recovery owner=$missingCheckpointOwner)",
    async ({ runSetupScript, missingCheckpointOwner }) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", support.testState.root);
      onTestFinished(() => {
        vi.unstubAllEnvs();
      });
      vi.mocked(prepareRepositoryGitHubIdentity).mockResolvedValue(
        createGitHubReadIdentity({
          token: undefined,
          selection: { source: "anonymous" },
          assertSelected: () => {},
          readToken: async () => undefined,
        }),
      );
      const { root: stagingRoot, baseCommit } = await createFixtureRepository("checkpoint-source", {
        content: "pinned source\n",
        disableSigning: true,
      });
      const base = await captureWorkspaceManifest({ root: stagingRoot, baseCommit });
      if (!missingCheckpointOwner) {
        await fs.writeFile(path.join(stagingRoot, "session.txt"), "accepted session change\n");
      }
      const current = await captureWorkspaceManifest({ root: stagingRoot, baseCommit });
      const repositoryStore = getSessionRepositoryWorkspaceStore();
      expect(repositoryStore.path).toBe(support.testState.stateDb.path);
      const created = await repositoryStore.create({
        agentId: REQUEST.agentId,
        sessionKey: REQUEST.sessionKey,
        url: "https://github.com/example/project.git",
        requestedRef: "refs/heads/main",
        runSetupScript: true,
        assertCurrent: () => {},
      });
      const pinned = await repositoryStore.bindBase({
        workspaceId: created.workspaceId,
        expectedRevision: created.revision,
        baseCommit,
        baseManifestHash: base.manifestRef,
        assertCurrent: () => {},
      });
      const staged = await stageSessionRepositoryCheckpoint({
        workspaceId: pinned.workspaceId,
        expectedRevision: pinned.revision,
        stagingRoot,
        baseManifestRaw: serializeWorkerWorkspaceManifest(base.manifest),
        currentManifestRaw: serializeWorkerWorkspaceManifest(current.manifest),
        baseManifestRef: base.manifestRef,
        currentManifestRef: current.manifestRef,
        assertCurrent: () => {},
      });
      try {
        await staged.publish();
      } finally {
        await staged.discard();
      }
      const accepted = (await repositoryStore.get(created.workspaceId))!;
      const boundWorkspace = {
        workspaceDir: "/worker/prepared/project",
        sourceManifestRef: base.manifestRef,
        preparedManifestRef: base.manifestRef,
      };
      const recoveryPlacements = createWorkerSessionPlacementStore({
        database: support.testState.stateDb,
        now: () => support.testState.nowMs,
      });
      if (missingCheckpointOwner) {
        const readProjection = recoveryPlacements.readProjection.bind(recoveryPlacements);
        const interruptedRead = vi
          .spyOn(recoveryPlacements, "readProjection")
          .mockImplementation(async (...args) => {
            const facts = await readProjection(...args);
            // An unavailable authoritative owner must never authorize reconstruction.
            return { ...facts, placements: new Map() };
          });
        onTestFinished(() => interruptedRead.mockRestore());
      }
      const { harness, store, ready, request } = await preparedHarness({
        placements: recoveryPlacements,
        repository: { ...accepted, baseCommit },
        boundWorkspace,
        ...(runSetupScript ? { recipe: lifecycleRecipe } : {}),
      });
      const startTunnel = vi.mocked(harness.environments.startTunnel);
      const ordinaryTunnel = startTunnel.getMockImplementation()!;
      startTunnel.mockImplementation(async (params) => {
        const tunnel = await ordinaryTunnel(params);
        vi.spyOn(tunnel, "syncWorkspace").mockImplementation(async ({ source }) => {
          harness.log.push("sync");
          expect(source).toMatchObject({
            kind: "repository",
            url: accepted.url,
            ref: accepted.requestedRef,
            branch: accepted.branch,
            baseCommit,
            runSetupScript: false,
            prepared: { ...boundWorkspace, baseCommit },
          });
          if (source.kind !== "repository" || !source.checkpoint) {
            throw new Error("Prepared dispatch lost its accepted repository checkpoint");
          }
          expect(
            await fs.readFile(path.join(source.checkpoint.stagingRoot, "session.txt"), "utf8"),
          ).toBe("accepted session change\n");
          return {
            mode: "repository",
            remoteWorkspaceDir: boundWorkspace.workspaceDir,
            baseCommit,
            baseManifestRef: base.manifestRef,
            manifestRef: current.manifestRef,
          };
        });
        return tunnel;
      });

      if (missingCheckpointOwner) {
        const artifact = repositoryStore.artifactPath(accepted.workspaceId);
        await fs.rm(artifact, { recursive: true });
        await expect(harness.service.dispatch({ ...request, runSetupScript })).rejects.toThrow(
          "unresolved worker recovery",
        );
        expect(harness.log).not.toContain("sync");
        expect(await repositoryStore.get(accepted.workspaceId)).toEqual(accepted);
        await expect(fs.stat(artifact)).rejects.toMatchObject({ code: "ENOENT" });
        return;
      }
      const active = await harness.service.dispatch({ ...request, runSetupScript });

      expect(harness.environments.prepareProjectIntent).toHaveBeenCalledWith(request.profileId, {
        machineClass: undefined,
        os: undefined,
        executionMode: request.executionMode,
        projectPath: undefined,
        repository: {
          agentId: request.agentId,
          url: accepted.url,
          ref: accepted.requestedRef,
          baseCommit,
        },
        runSetupScript,
        inherited: undefined,
        signal: undefined,
        setupAuthorized: true,
      });
      expect(active).toMatchObject({
        state: "active",
        environmentId: ready.environmentId,
        remoteWorkspaceDir: boundWorkspace.workspaceDir,
        workspaceBaseManifestRef: current.manifestRef,
      });
      expect(harness.environments.createWithRequest).not.toHaveBeenCalled();
      expect(store.get(ready.environmentId)?.preparation?.consumedAtMs).toBe(1_000);
      expect(harness.log.indexOf("workspace:bind-prepared")).toBeLessThan(
        harness.log.indexOf("sync"),
      );
      expect(await repositoryStore.get(accepted.workspaceId)).toEqual(accepted);
      if (runSetupScript) {
        expect(harness.log.indexOf("sync")).toBeLessThan(
          harness.log.indexOf("lifecycle:post-create"),
        );
        expect(harness.log.indexOf("lifecycle:post-start")).toBeLessThan(
          harness.log.indexOf("placement:starting"),
        );
      }
      const checkpoint = await readSessionRepositoryArtifacts({
        workspaceId: accepted.workspaceId,
        assertCurrent: () => {},
      });
      expect(checkpoint.currentManifestRef).toBe(current.manifestRef);
      expect(harness.environments.schedulePreparedRefill).toHaveBeenCalledWith(ready.environmentId);
      const tunnel = await startTunnel.mock.results[0]!.value;
      expect(tunnel.quiesceWorkspace).not.toHaveBeenCalled();
      expect(tunnel.reconcileWorkspace).not.toHaveBeenCalled();
    },
  );
});

const integrationState = vi.hoisted(() => ({
  enabled: false,
  provider: { preparedCapacity: "image" as const },
}));
vi.mock("../../plugins/repository-integration-runtime.js", () => ({
  getRepositoryIntegration: () =>
    integrationState.enabled ? integrationState.provider : undefined,
}));
afterEach(() => {
  integrationState.enabled = false;
});
