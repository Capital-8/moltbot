import { afterEach, describe, expect, vi } from "vitest";
import { createCommandTest } from "../../test/helpers/command-fixture.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import type {
  WorkerRetainedLeaseReceipt,
  WorkerSessionDiskRetention,
} from "../plugins/worker-retention.types.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { disposeSessionReadContexts } from "./session-read-contexts.test-support.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";
import { REQUEST } from "./worker-environments/placement-dispatch-test-fixtures.js";
import { createHarness } from "./worker-environments/placement-dispatch-test-harness.js";
import { placementTurnOwner } from "./worker-environments/placement-record.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import * as workerSupport from "./worker-environments/service.test-support.js";

const it = createCommandTest();
const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
afterEach(async () => {
  await disposeSessionReadContexts();
  await closeOpenClawStateDatabaseAsync();
});

it.for([
  { method: "sessions.delete", providerFailure: false },
  { method: "sessions.patch", providerFailure: false },
  { method: "sessions.delete", providerFailure: true },
  { method: "sessions.patch", providerFailure: true },
] as const)(
  "$method retires an offline retained reclaim owner (provider failure=$providerFailure)",
  async ({ method, providerFailure }, { command }) => {
    const { dir, storePath } = await createSessionStoreDir();
    expect((await command.run("git", ["init", "--quiet", dir])).status).toBe(0);
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: dir } });
    const placements = createWorkerSessionPlacementStore({ database });
    const unavailable = vi.fn(async () => {
      throw new Error("device worker node is not connected with the supervisor dialect");
    });
    const harness = await createHarness(database, placements, {
      workspacePath: dir,
      destroyFails: providerFailure,
      withPreparedRecovery: unavailable,
    });
    const draining = await harness.placements.seedDraining(2);
    if (draining.state !== "draining") {
      throw new Error("Expected draining fixture");
    }
    harness.markEnvironmentOwnerEpoch(draining.activeOwnerEpoch);
    harness.markEnvironmentNodeDeviceId("stopped-retained-node");
    const retention: WorkerSessionDiskRetention = {
      policy: { mode: "session-disk", computeWindowSeconds: 14400 },
      owner: REQUEST,
      ownerBinding: "a".repeat(64),
      desiredState: "suspended",
      receipt: null,
      operation: null,
    };
    const readEnvironment = vi.mocked(harness.environments.get).getMockImplementation();
    if (!readEnvironment) {
      throw new Error("Missing environment fixture");
    }
    vi.mocked(harness.environments.get).mockImplementation((id) => {
      const record = readEnvironment(id);
      return record ? { ...record, retention } : record;
    });
    const claim = await placements.claimReclaimWorkspaceResult({
      ...REQUEST,
      claimId: "reclaim-offline-retirement",
      runId: "reclaim-offline-retirement",
      owner: placementTurnOwner(draining),
    });
    await placements.handoffWorkspaceResultRecovery(claim);
    await writeSessionStore({
      entries: { [REQUEST.sessionKey]: sessionStoreEntry(REQUEST.sessionId) },
    });

    const result = await directSessionReq(
      method,
      {
        key: REQUEST.sessionKey,
        expectedSessionId: REQUEST.sessionId,
        ...(method === "sessions.patch" ? { archived: true } : {}),
      },
      {
        context: {
          workerEnvironmentService: harness.environments,
          workerSessionPlacementService: placements,
          workerPlacementDispatchService: harness.service,
        },
      },
    );

    expect(result).toMatchObject({ ok: !providerFailure });
    expect(unavailable).not.toHaveBeenCalled();
    expect(harness.environments.createWithRequest).not.toHaveBeenCalled();
    expect(harness.environments.startTunnel).not.toHaveBeenCalled();
    expect(harness.environments.destroy).toHaveBeenCalledOnce();
    const entry = loadSessionEntry({ storePath, sessionKey: REQUEST.sessionKey });
    if (providerFailure) {
      expect(entry?.sessionId).toBe(REQUEST.sessionId);
      expect(entry?.archivedAt).toBeUndefined();
      expect(placements.get(REQUEST.sessionId)?.state).toBe("failed");
      expect(harness.environments.get(draining.environmentId)?.state).not.toBe("destroyed");
    } else {
      expect(harness.environments.get(draining.environmentId)?.state).toBe("destroyed");
      expect(await placements.listPendingWorkspaceResultsAsync(REQUEST.sessionId)).toEqual([]);
      if (method === "sessions.patch") {
        expect(entry?.archivedAt).toEqual(expect.any(Number));
      } else {
        expect(entry).toBeUndefined();
        expect(placements.get(REQUEST.sessionId)).toBeUndefined();
      }
    }
  },
);

describe("retained session action before provider cleanup", () => {
  workerSupport.setupWorkerEnvironmentServiceSuite();

  it.for(["sessions.delete", "sessions.patch"] as const)(
    "%s keeps exact cleanup ownership after the session action and restart",
    async (method, { command }) => {
      const { dir, storePath } = await createSessionStoreDir();
      expect((await command.run("git", ["init", "--quiet", dir])).status).toBe(0);
      let cleanupAvailable = false;
      const unavailable = vi.fn(async () => {
        throw new Error("Offline worker cannot run workspace commands");
      });
      const physicalCleanup = vi.fn(async () => {
        if (!cleanupAvailable) {
          throw new Error("Provider cleanup is unavailable");
        }
      });
      const provider = workerSupport.createProvider({
        retainedLease: {
          inspect: unavailable,
          pause: unavailable,
          resume: unavailable,
          destroy: physicalCleanup,
        },
      });
      let workerService = workerSupport.createService(provider);
      const placements = createWorkerSessionPlacementStore({
        database: workerSupport.testState.stateDb,
      });
      const harness = await createHarness(workerSupport.testState.stateDb, placements, {
        workspacePath: dir,
        environmentService: workerService,
        withPreparedRecovery: unavailable,
      });
      const environmentId = harness.attached.environmentId;
      const leaseId = "cbx_0123456789ab";
      const retention: WorkerSessionDiskRetention = {
        policy: { mode: "session-disk", computeWindowSeconds: 14400 },
        owner: REQUEST,
        ownerBinding: "a".repeat(64),
        desiredState: "suspended",
        receipt: null,
        operation: null,
      };
      const environmentStore = workerSupport.testState.store;
      await environmentStore.createIntent({
        environmentId,
        providerId: provider.id,
        profileId: "development",
        profileSnapshot: { settings: {} },
        provisionOperationId: "retained-cleanup-dispatch",
        retention,
      });
      await environmentStore.transition({ environmentId, from: "requested", to: "provisioning" });
      await environmentStore.transition({
        environmentId,
        from: "provisioning",
        to: "ready",
        patch: {
          ...workerSupport.readyPatch(environmentId),
          leaseId,
          nodeDeviceId: "offline-retained-node",
          sharedHost: false,
        },
      });
      await environmentStore.transition({
        environmentId,
        from: "ready",
        to: "attached",
        patch: workerSupport.attachedPatch(environmentId, REQUEST.sessionId),
      });
      const draining = await harness.placements.seedDraining(2);
      if (draining.state !== "draining") {
        throw new Error("Expected draining fixture");
      }
      const claim = await placements.claimReclaimWorkspaceResult({
        ...REQUEST,
        claimId: "reclaim-retained-cleanup",
        runId: "reclaim-retained-cleanup",
        owner: placementTurnOwner(draining),
      });
      await placements.handoffWorkspaceResultRecovery(claim);
      await writeSessionStore({
        entries: { [REQUEST.sessionKey]: sessionStoreEntry(REQUEST.sessionId) },
      });
      const result = await directSessionReq(
        method,
        {
          key: REQUEST.sessionKey,
          expectedSessionId: REQUEST.sessionId,
          ...(method === "sessions.patch" ? { archived: true } : {}),
        },
        {
          context: {
            workerEnvironmentService: workerService,
            workerSessionPlacementService: placements,
            workerPlacementDispatchService: harness.service,
          },
        },
      );
      expect(result).toMatchObject({ ok: true });
      expect(physicalCleanup).not.toHaveBeenCalled();
      expect(unavailable).not.toHaveBeenCalled();
      expect(environmentStore.getCredential(environmentId)).toBeUndefined();
      expect(environmentStore.get(environmentId)).toMatchObject({ retention });
      expect(environmentStore.get(environmentId)?.destroyRequestedAtMs).not.toBeNull();
      expect(environmentStore.get(environmentId)?.state).not.toBe("destroyed");
      const entry = loadSessionEntry({ storePath, sessionKey: REQUEST.sessionKey });
      if (method === "sessions.patch") {
        expect(entry?.archivedAt).toEqual(expect.any(Number));
      } else {
        expect(entry).toBeUndefined();
      }
      await workerService.reconcileOnce();
      expect(physicalCleanup).toHaveBeenCalledOnce();
      expect(environmentStore.get(environmentId)?.state).not.toBe("destroyed");
      await workerService.stop();
      await workerSupport.reopenWorkerEnvironmentStore();
      cleanupAvailable = true;
      workerService = workerSupport.createService(provider);
      await workerService.reconcileOnce();
      expect(workerSupport.testState.store.get(environmentId)).toMatchObject({
        state: "destroyed",
        retention,
      });
      expect(physicalCleanup).toHaveBeenLastCalledWith(
        expect.objectContaining({
          leaseId,
          retention,
        }),
      );
    },
  );
});

describe("retained session action after proven provider loss", () => {
  workerSupport.setupWorkerEnvironmentServiceSuite();

  it.for([
    { method: "sessions.delete", change: "none" },
    { method: "sessions.patch", change: "none" },
    { method: "sessions.patch", change: "foreign-owner" },
    { method: "sessions.patch", change: "binding-change" },
    { method: "sessions.patch", change: "unknown-turn" },
    { method: "sessions.patch", change: "epoch-change" },
  ] as const)(
    "$method after owner401 retirement preserves $change custody",
    async ({ method, change }, { command }) => {
      const { dir, storePath } = await createSessionStoreDir();
      expect((await command.run("git", ["init", "--quiet", dir])).status).toBe(0);
      const unavailable = vi.fn(async () => {
        throw new Error("Absent worker cannot run workspace commands");
      });
      const receipt: WorkerRetainedLeaseReceipt = {
        schema: "test.retained-lease.v1",
        mode: "session-disk",
        ownerBinding: "a".repeat(64),
        identity: {
          leaseId: "retained-gone",
          attemptLeaseId: "retained-attempt",
          slug: "retained",
          resourceId: "retained-resource",
        },
        claimRevision: "1",
        computeWindowSeconds: 14400,
        desiredState: "suspended",
        computeWindow: {
          id: "retained-window",
          authorizedAt: "2026-01-01T00:00:00Z",
          expiresAt: "2026-01-01T04:00:00Z",
          state: "closed",
        },
        policyVerified: true,
        observedState: "stopped",
        stopPending: false,
      };
      const retention: WorkerSessionDiskRetention = {
        policy: { mode: "session-disk", computeWindowSeconds: 14400 },
        owner: REQUEST,
        ownerBinding: receipt.ownerBinding,
        desiredState: "suspended",
        receipt,
        operation: null,
      };
      const physicalCleanup = vi.fn(async () => {});
      const provider = workerSupport.createProvider({
        inspect: async () => ({ status: "unknown" }),
        retainedLease: {
          inspect: async () => ({ ...receipt, observedState: "missing", policyVerified: false }),
          pause: unavailable,
          resume: unavailable,
          destroy: physicalCleanup,
        },
      });
      const workerService = workerSupport.createService(provider);
      const placements = createWorkerSessionPlacementStore({
        database: workerSupport.testState.stateDb,
      });
      const harness = await createHarness(workerSupport.testState.stateDb, placements, {
        workspacePath: dir,
        environmentService: workerService,
        withPreparedRecovery: unavailable,
      });
      const environmentId = harness.attached.environmentId;
      const environmentStore = workerSupport.testState.store;
      await environmentStore.createIntent({
        environmentId,
        providerId: provider.id,
        profileId: "development",
        profileSnapshot: { settings: {} },
        provisionOperationId: "retained-gone-dispatch",
        retention,
      });
      await environmentStore.transition({ environmentId, from: "requested", to: "provisioning" });
      await environmentStore.transition({
        environmentId,
        from: "provisioning",
        to: "ready",
        patch: {
          ...workerSupport.readyPatch(environmentId),
          leaseId: receipt.identity.leaseId,
          nodeDeviceId: "gone-retained-node",
          sharedHost: false,
        },
      });
      await environmentStore.transition({
        environmentId,
        from: "ready",
        to: "attached",
        patch: workerSupport.attachedPatch(environmentId, REQUEST.sessionId),
      });
      const active = await harness.placements.seedActive(401);
      if (active.state !== "active") {
        throw new Error("Expected active retained fixture");
      }
      if (change === "unknown-turn") {
        await placements.claimTurn({
          ...REQUEST,
          claimId: "unknown-retained-claim",
          runId: "unknown-retained-run",
          owner: placementTurnOwner(active),
        });
      }
      // Run the real loss owner: missing retained observation, provider inspection,
      // exact retained cleanup, credential revocation and terminal state publication.
      await workerService.reconcileOnce();
      expect(environmentStore.get(environmentId)).toMatchObject({
        state: "failed",
        leaseId: null,
        ownerEpoch: 402,
        sharedHost: null,
        nodeDeviceId: null,
        attachedSessionIds: [],
        retention,
      });
      expect(environmentStore.getCredential(environmentId)).toBeUndefined();
      expect(physicalCleanup).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ leaseId: receipt.identity.leaseId, retention }),
      );
      if (change !== "unknown-turn") {
        await harness.service.reconcile();
        expect(placements.get(REQUEST.sessionId)).toMatchObject({
          state: "failed",
          activeOwnerEpoch: 401,
          turnClaim: null,
        });
      }
      const before = placements.get(REQUEST.sessionId);
      let changed = change === "foreign-owner";
      const readEnvironment = workerService.get.bind(workerService);
      vi.spyOn(harness.environments, "get").mockImplementation((id) => {
        const current = readEnvironment(id);
        if (!current?.retention || !changed) {
          return current;
        }
        if (change === "epoch-change") {
          return { ...current, ownerEpoch: current.ownerEpoch + 1 };
        }
        return {
          ...current,
          retention: {
            ...current.retention,
            ...(change === "foreign-owner"
              ? { owner: { ...REQUEST, sessionId: "foreign-session" } }
              : { ownerBinding: "b".repeat(64) }),
          },
        };
      });
      if (change === "binding-change" || change === "epoch-change") {
        const destroy = harness.environments.destroy.bind(harness.environments);
        vi.spyOn(harness.environments, "destroy").mockImplementation((...args) => {
          changed = true;
          return destroy(...args);
        });
      }
      await writeSessionStore({
        entries: { [REQUEST.sessionKey]: sessionStoreEntry(REQUEST.sessionId) },
      });
      const context = {
        workerEnvironmentService: workerService,
        workerSessionPlacementService: placements,
        workerPlacementDispatchService: harness.service,
      };
      const params = {
        key: REQUEST.sessionKey,
        expectedSessionId: REQUEST.sessionId,
        ...(method === "sessions.patch" ? { archived: true } : {}),
      };
      let retirementFailure: unknown;
      const reclaim = harness.service.reclaim.bind(harness.service);
      vi.spyOn(harness.service, "reclaim").mockImplementation(async (...args) => {
        try {
          return await reclaim(...args);
        } catch (error) {
          retirementFailure = error;
          throw error;
        }
      });
      const result = await directSessionReq(method, params, { context });
      const entry = loadSessionEntry({ storePath, sessionKey: REQUEST.sessionKey });
      expect(unavailable).not.toHaveBeenCalled();
      // Retirement must not issue another physical destroy, allocate, or contact the absent worker.
      expect(physicalCleanup).toHaveBeenCalledOnce();
      expect(environmentStore.get(environmentId)).toMatchObject({
        state: "failed",
        leaseId: null,
        ownerEpoch: 402,
        retention,
      });
      if (change !== "none") {
        expect(retirementFailure).toMatchObject({
          message:
            change === "unknown-turn"
              ? "Retained retirement is waiting for active model work to settle"
              : "Retained retirement worker owner changed",
        });
        expect(result).toMatchObject({ ok: false });
        expect(entry?.sessionId).toBe(REQUEST.sessionId);
        expect(entry?.archivedAt).toBeUndefined();
        expect(placements.get(REQUEST.sessionId)).toEqual(before);
      } else {
        expect(result, JSON.stringify(result.error)).toMatchObject({ ok: true });
        expect(await placements.listPendingWorkspaceResultsAsync(REQUEST.sessionId)).toEqual([]);
        expect(await placements.listWorkspaceReconciliationOwners()).toEqual([]);
        if (method === "sessions.patch") {
          expect(entry?.archivedAt).toEqual(expect.any(Number));
          expect(placements.get(REQUEST.sessionId)?.state).toBe("local");
          expect(await directSessionReq(method, params, { context })).toMatchObject({ ok: true });
          expect(physicalCleanup).toHaveBeenCalledOnce();
        } else {
          expect(entry).toBeUndefined();
          expect(placements.get(REQUEST.sessionId)).toBeUndefined();
        }
      }
    },
  );
});
