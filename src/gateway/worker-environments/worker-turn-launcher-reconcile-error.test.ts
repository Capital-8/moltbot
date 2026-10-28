import { expect, it, vi } from "vitest";
import {
  WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE,
  WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
  WORKER_RPC_SET_VERSION,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { NODE_WORKER_ENVIRONMENT_STOP_COMMAND } from "../../infra/node-commands.js";
import type { WorkerProvider } from "../../plugins/types.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { installWorkerPlacementReconcileGuard } from "../server-worker-placement-reconcile-guard.js";
import { createWorkerRuntimeRefreshWaiter } from "../server-worker-placement-runtime-refresh.js";
import { StaleWorkerBuildError } from "./admission.js";
import { hashWorkerCredential } from "./credential.js";
import { createNodeWorkerTunnelManager } from "./node-worker-tunnel.js";
import {
  transport,
  withWorkspaceDrain,
  workspaceTransfer,
} from "./node-worker-tunnel.test-support.js";
import { coordinateWorkerPlacementDispatch } from "./placement-dispatch-coordinator.js";
import { advancePlacementFixtureToActive } from "./placement-test-fixtures.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import { createWorkerPreparationIdentity } from "./preparation-identity.js";
import { createProviderReplayDispatch } from "./provider-replay.test-support.js";
import { createWorkerEnvironmentService, type WorkerEnvironmentService } from "./service.js";
import { BUNDLE_ARTIFACT, createProvider } from "./service.test-support.js";
import { createWorkerEnvironmentStore } from "./store.js";
import { WorkerTunnelOwnerDisconnectedError } from "./tunnel-contract.js";
import { executeTurn, installLauncherTest } from "./worker-turn-launcher-flow.test-support.js";
import {
  type WorkerTurnLauncherOptions,
  ENVIRONMENT_ID,
  seedActivePlacement,
  MANIFEST_REF,
  createWorkerTurnTunnel,
  reconcileUnchangedLocalWorkspace,
  SESSION_ID,
  SESSION_KEY,
  createWorkerSessionTurnPlacementProvider,
  database,
  placements,
  root,
} from "./worker-turn-launcher.test-support.js";
import { createWorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";
import { createWorkerWorkspaceRecoveryFixture } from "./workspace-recovery.test-support.js";

installLauncherTest();

async function createRecoveryDispatch(
  environments: WorkerEnvironmentService,
  workspaceOperations: ReturnType<typeof createWorkerWorkspaceOperationCoordinator>,
  hasCurrentRunner?: (nodeId: string) => boolean,
) {
  return coordinateWorkerPlacementDispatch(
    createProviderReplayDispatch({
      initialPlacements: await placements.listAsync(),
      placements,
      environments,
      hasCurrentRunner,
      workspaceOperations,
      runRecoveryBarrier: async ({ run }) => await run({ kind: "local", path: root }),
      runReclaimBarrier: async ({ begin, reclaim }) =>
        await reclaim({ kind: "local", path: root }, await begin()),
      ...createWorkerWorkspaceRecoveryFixture({
        resolveWorkspace: async () => ({ kind: "local", path: root }),
      }),
    }),
    (_request, run) => run(),
  );
}

it("resumes a deferred idle-reclaim node before a distinct fresh turn waits for its workspace", async () => {
  const store = await createWorkerEnvironmentStore({ database });
  const artifact = {
    ...BUNDLE_ARTIFACT,
    protocolFeatures: [
      WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
      WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE,
    ],
  };
  const preparation = createWorkerPreparationIdentity({
    namespace: "deferred-reclaim-fixture",
    providerId: "fake",
    profileId: "development",
    profileSnapshot: { settings: {} },
    imageReserve: true,
    target: { machineClass: "test", platform: "linux" },
    artifacts: {
      nodeBootstrapSha256: "a".repeat(64),
      enabledPluginIds: [],
      workerBundleHash: artifact.bundleHash,
      workerArchiveSha256: artifact.tarballSha256,
      openclawVersion: artifact.openclawVersion,
      protocolFeatures: artifact.protocolFeatures,
    },
  });
  let connected = false;
  const resumeNode = vi.fn<NonNullable<WorkerProvider["resumeNode"]>>(async (request) => {
    request.assertCurrent();
    connected = true;
  });
  const destroy = vi.fn(async () => {});
  const environments = createWorkerEnvironmentService({
    scheduler: createTestGatewayScheduler(),
    store,
    getConfig: () => ({}),
    resolveProvider: () =>
      createProvider({
        resumeNode,
        destroy,
        inspect: async () => ({ status: "active", sharedHost: false }),
      }),
    prepareInstallation: async () => artifact,
    bootstrapWorker: vi.fn(),
    placementStore: createWorkerSessionPlacementGate(placements),
    nodeTunnelManager: {
      beginClose: () => {},
      status: () => (connected ? "connected" : "stopped"),
      observeProcesses: vi.fn(),
      start: async (request) =>
        createWorkerTurnTunnel({
          ownerEpoch: request.ownerEpoch,
          launchTurn: vi.fn(),
          reconcileWorkspace: reconcileUnchangedLocalWorkspace,
          quiesceWorkspace: async () => {
            if (!connected) {
              throw new WorkerTunnelOwnerDisconnectedError(
                "device worker node is not connected with supervisor dialect",
              );
            }
            return { assertActive: async () => {}, resume: async () => {} };
          },
        }),
      stop: async () => {},
      stopAll: async () => {},
    },
  });
  await store.createIntent({
    environmentId: ENVIRONMENT_ID,
    providerId: "fake",
    profileId: "development",
    profileSnapshot: {
      settings: {},
      executionMode: "remote-exec",
      runtimePreparation: { ...preparation, source: "image" },
    },
    provisionOperationId: "deferred-reclaim",
  });
  await store.transition({
    environmentId: ENVIRONMENT_ID,
    from: "requested",
    to: "provisioning",
  });
  const ready = await store.transition({
    environmentId: ENVIRONMENT_ID,
    from: "provisioning",
    to: "ready",
    patch: {
      leaseId: "retained-node-lease",
      nodeDeviceId: "retained-node",
      sharedHost: false,
      bootstrapReceipt: {
        bundleHash: artifact.bundleHash,
        openclawVersion: artifact.openclawVersion,
        protocolFeatures: artifact.protocolFeatures,
        installKind: "bundle",
      },
      credential: {
        credentialHash: hashWorkerCredential("deferred-reclaim-credential"),
        sessionId: null,
        rpcSetVersion: WORKER_RPC_SET_VERSION,
        expiresAtMs: Date.now() + 60_000,
      },
    },
  });
  const attached = await environments.attachSession({
    environmentId: ENVIRONMENT_ID,
    ownerEpoch: ready.ownerEpoch,
    sessionId: SESSION_ID,
  });
  await advancePlacementFixtureToActive(
    placements,
    database,
    {
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      agentId: "main",
      executionMode: "remote-exec",
    },
    {
      environmentId: ENVIRONMENT_ID,
      ownerEpoch: attached.ownerEpoch,
      workerBundleHash: artifact.bundleHash,
      remoteWorkspaceDir: "/worker/workspace",
      workspaceBaseManifestRef: MANIFEST_REF,
      seedEnvironment: false,
    },
  );
  const workspaceOperations = createWorkerWorkspaceOperationCoordinator();
  const dispatch = await createRecoveryDispatch(environments, workspaceOperations, () => connected);
  try {
    // The real idle-cleanup entry commits drain before discovering the dead supervisor.
    await expect(
      dispatch.reclaim({ sessionId: SESSION_ID, sessionKey: SESSION_KEY, agentId: "main" }),
    ).rejects.toThrow("not connected");
    await dispatch.reconcileActive(ENVIRONMENT_ID);
    const [pending] = await placements.listPendingWorkspaceResultsAsync(SESSION_ID);
    expect(pending).toMatchObject({
      workspaceAcceptedAtMs: null,
      stagedResultRef: null,
      recoveryRequestedAtMs: expect.any(Number),
    });
    expect(placements.get(SESSION_ID)).toMatchObject({ state: "draining" });
    const waiter = createWorkerRuntimeRefreshWaiter({ environments, isStopping: () => false });
    waiter.bind(
      async (_nodeId, request) => {
        request.assertCurrent();
        expect(connected).toBe(true);
      },
      async () => connected,
    );
    const redispatchPlacement = vi.fn<WorkerTurnLauncherOptions["redispatchPlacement"]>(
      async (placement, authority) => {
        authority.assertCurrent?.();
        expect(placement).toMatchObject({ state: "reclaimed", turnClaim: null });
        throw new Error("Fresh authenticated repository dispatch required");
      },
    );
    const launcher = createWorkerSessionTurnPlacementProvider({
      placements,
      environments,
      workspaceOperations,
      reconcileActivePlacement: dispatch.reconcileActive,
      waitForAdmissionNode: waiter.wait,
      redispatchPlacement,
    });
    // A dead node cannot settle this wait by itself; trap that original failure promptly.
    const wait = vi
      .spyOn(placements, "waitForTurnClaimRelease")
      .mockRejectedValueOnce(new Error("Pending cleanup waited without resuming its node"));
    const runLocal = vi.fn();
    await expect(executeTurn(launcher, "fresh-after-deferred-reclaim", runLocal)).rejects.toThrow(
      "Fresh authenticated repository dispatch required",
    );
    expect(wait).not.toHaveBeenCalled();
    expect(resumeNode).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
    expect(redispatchPlacement).toHaveBeenCalledOnce();
    expect(runLocal).not.toHaveBeenCalled();
    expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([]);
    expect(placements.get(SESSION_ID)).toMatchObject({ state: "reclaimed", turnClaim: null });
  } finally {
    await environments.stop();
  }
});

it.each(["remote-exec", "worker-turn"] as const)(
  "reconciles provider loss before a fresh %s turn reaches authenticated redispatch",
  async (executionMode) => {
    await seedActivePlacement(executionMode);
    const store = await createWorkerEnvironmentStore({ database });
    const inspect = vi.fn(async () => ({ status: "destroyed" as const }));
    const provider = createProvider({ inspect });
    const environments = createWorkerEnvironmentService({
      scheduler: createTestGatewayScheduler(),
      store,
      getConfig: () => ({}),
      resolveProvider: () => provider,
      prepareInstallation: async () => BUNDLE_ARTIFACT,
      bootstrapWorker: vi.fn(),
      placementStore: createWorkerSessionPlacementGate(placements),
    });
    const workspaceOperations = createWorkerWorkspaceOperationCoordinator();
    const dispatch = await createRecoveryDispatch(environments, workspaceOperations);
    const runLocal = vi.fn();
    const startTunnel = vi.spyOn(environments, "startTunnel");
    const waitForAdmissionNode = vi.fn(async () => {
      throw new Error("A lost worker cannot acknowledge a restart drain");
    });
    const redispatchPlacement = vi.fn<WorkerTurnLauncherOptions["redispatchPlacement"]>(
      async (placement, authority) => {
        authority.assertCurrent?.();
        expect(placement).toMatchObject({ state: "failed", turnClaim: null });
        throw new Error("Fresh authenticated repository dispatch required");
      },
    );
    try {
      // Settle actual provider loss, without manually reclaiming the active placement.
      await environments.reconcileEnvironment(ENVIRONMENT_ID);
      expect(inspect).toHaveBeenCalledOnce();
      expect(environments.get(ENVIRONMENT_ID)).toMatchObject({ state: "failed", leaseId: null });
      expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
      const launcher = createWorkerSessionTurnPlacementProvider({
        placements,
        environments,
        workspaceOperations,
        reconcileActivePlacement: dispatch.reconcileActive,
        waitForAdmissionNode,
        redispatchPlacement,
      });
      const runId = "fresh-input-after-provider-expiry";
      await expect(executeTurn(launcher, runId, runLocal)).rejects.toThrow(
        "Fresh authenticated repository dispatch required",
      );
      expect(redispatchPlacement).toHaveBeenCalledOnce();
      expect(waitForAdmissionNode).not.toHaveBeenCalled();
      expect(startTunnel).not.toHaveBeenCalled();
      expect(runLocal).not.toHaveBeenCalled();
      expect(placements.get(SESSION_ID)).toMatchObject({ state: "failed", turnClaim: null });
      expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([]);
    } finally {
      await environments.stop();
    }
  },
);

it("settles a stale-build turn when a lost shared node rejects its stop acknowledgement", async () => {
  const store = await createWorkerEnvironmentStore({ database });
  let installation = {
    ...BUNDLE_ARTIFACT,
    protocolFeatures: [
      WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
      WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE,
    ],
  };
  const nodeTransport = transport();
  let rejectStop = true;
  const stopRequests = vi.fn<typeof nodeTransport.invoke>(async (request) => {
    expect(request.command).toBe(NODE_WORKER_ENVIRONMENT_STOP_COMMAND);
    return rejectStop
      ? { ok: false, error: { code: "UNAVAILABLE" } }
      : { ok: true, payloadJSON: "null" };
  });
  vi.spyOn(nodeTransport, "invoke").mockImplementation(withWorkspaceDrain(stopRequests));
  const nodeTunnelManager = createNodeWorkerTunnelManager({
    gatewayDeviceId: "gateway-recovery-fixture",
    getEnvironment: store.get,
    listEnvironments: store.list,
    getTransport: () => nodeTransport,
    launchNodeWorker: vi.fn(),
    validateWorkerTurn: (claim) => placements.validateTurnClaim(claim),
    workspaceTransfer: workspaceTransfer({ closeAll: vi.fn(async () => {}) }),
  });
  const inspect = vi
    .fn<WorkerProvider["inspect"]>(async () => ({ status: "destroyed" }))
    .mockResolvedValueOnce({ status: "active" });
  const provider = createProvider({ supportedExecutionModes: ["worker-turn"], inspect });
  const warn = vi.fn();
  const environments = createWorkerEnvironmentService({
    scheduler: createTestGatewayScheduler(),
    store,
    getConfig: () => ({}),
    resolveProvider: () => provider,
    prepareInstallation: async () => installation,
    bootstrapWorker: vi.fn(),
    placementStore: createWorkerSessionPlacementGate(placements),
    nodeTunnelManager,
    logger: { warn },
  });
  const workspaceOperations = createWorkerWorkspaceOperationCoordinator();
  const dispatch = await createRecoveryDispatch(environments, workspaceOperations);
  const uninstall = installWorkerPlacementReconcileGuard({
    placements,
    environments,
    dispatch,
    isStopping: () => false,
  });
  try {
    await store.createIntent({
      environmentId: ENVIRONMENT_ID,
      providerId: provider.id,
      profileId: "development",
      profileSnapshot: { executionMode: "worker-turn", settings: { device: "node-1" } },
      provisionOperationId: "shared-node-recovery",
    });
    await store.transition({
      environmentId: ENVIRONMENT_ID,
      from: "requested",
      to: "provisioning",
    });
    const ready = await store.transition({
      environmentId: ENVIRONMENT_ID,
      from: "provisioning",
      to: "ready",
      patch: {
        leaseId: "shared-node-lease",
        nodeDeviceId: "node-1",
        sharedHost: true,
        credential: {
          credentialHash: hashWorkerCredential("ready-worker-recovery-fixture"),
          sessionId: null,
          rpcSetVersion: WORKER_RPC_SET_VERSION,
          expiresAtMs: Date.now() + 60_000,
        },
        bootstrapReceipt: {
          bundleHash: installation.bundleHash,
          openclawVersion: installation.openclawVersion,
          protocolFeatures: installation.protocolFeatures,
          installKind: "bundle",
        },
      },
    });
    const attached = await environments.attachSession({
      environmentId: ENVIRONMENT_ID,
      ownerEpoch: ready.ownerEpoch,
      sessionId: SESSION_ID,
    });
    await advancePlacementFixtureToActive(
      placements,
      database,
      {
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        agentId: "main",
        executionMode: "worker-turn",
      },
      {
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: attached.ownerEpoch,
        workerBundleHash: installation.bundleHash,
        remoteWorkspaceDir: "/worker/workspace",
        seedEnvironment: false,
      },
    );
    installation = { ...installation, bundleHash: "d".repeat(64) };
    const startTunnel = vi.spyOn(environments, "startTunnel");
    const launcher = createWorkerSessionTurnPlacementProvider({
      placements,
      environments,
      workspaceOperations,
      reconcileActivePlacement: dispatch.reconcileActive,
    });
    const runId = "stale-build-shared-node-stop-failed";
    const failure = await executeTurn(launcher, runId, vi.fn()).catch((error: unknown) => error);

    expect(startTunnel).toHaveBeenCalledOnce();
    await expect(startTunnel.mock.results[0]?.value).rejects.toBeInstanceOf(StaleWorkerBuildError);
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(stopRequests).toHaveBeenCalled();
    expect(store.getCredential(ENVIRONMENT_ID)).toBeUndefined();
    expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([]);
    expect(placements.get(SESSION_ID)).toMatchObject({ state: "failed", turnClaim: null });
    expect(failure).toBeInstanceOf(Error);
    expect(warn).toHaveBeenCalledWith(
      `Worker environment reconcile failed (${ENVIRONMENT_ID}, ${provider.id})`,
    );
  } finally {
    rejectStop = false;
    await uninstall();
    await environments.stop();
  }
});
