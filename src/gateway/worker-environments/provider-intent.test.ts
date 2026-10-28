import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { PROTOCOL_VERSION } from "../../../packages/gateway-protocol/src/index.js";
import {
  WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE,
  WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { requireGit } from "../../agents/worktrees/git.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { createTestPluginApi } from "../../plugin-sdk/plugin-test-api.js";
import { importFreshModule } from "../../plugin-sdk/test-helpers/import-fresh.js";
import { resolvePluginModuleExport } from "../../plugins/module-export.js";
import type { RepositoryIntegration } from "../../plugins/repository-integration.types.js";
import type { WorkerProvider } from "../../plugins/types.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withRepositoryChatDispatch } from "../repository-dispatch.js";
const policy = vi.hoisted(() => ({ current: undefined as RepositoryIntegration | undefined }));
vi.mock("../../plugins/repository-integration-runtime.js", () => ({
  getRepositoryIntegration: () => policy.current,
}));
import type { GatewayClient } from "../server-methods/client-types.js";
import { bindDeviceWorkerAvailability } from "./device-provider.js";
import { completeWorkerNodeSetupForTest } from "./node-enrollment.test-support.js";
import { transport } from "./node-worker-tunnel.test-support.js";
import { prepareNodeWorkspaceTransferSnapshot } from "./node-workspace-transfer-snapshot.js";
import { REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { advancePlacementFixtureToActive } from "./placement-test-fixtures.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import {
  readWorkerPreparation,
  readWorkerProjectPreparation,
  workerPreparationSourceKey,
} from "./preparation-identity.schema.js";
import { createPreparedPoolPresence } from "./prepared-pool-presence.js";
import type { PreparedPoolPresenceDemand } from "./prepared-pool-presence.types.js";
import { createProviderIntentFixture as fixture } from "./provider-intent.test-support.js";
import { requireWorkerProfile } from "./service-validation.js";
import * as support from "./service.test-support.js";
import { createWorkerPlacementRedispatch } from "./worker-placement-redispatch.js";
import { createWorkerSessionTurnPlacementProvider } from "./worker-turn-launcher.js";
import {
  createWorkerTurnTunnel,
  setWorkerTurnSessionTarget,
  turn,
} from "./worker-turn-launcher.test-support.js";
import { createWorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";

describe("prepared worker intent admission", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("keeps empty workspaces cold on providers with only setup commands", async () => {
    const f = await fixture();
    f.provider.supportsProjectPreparation = () => false;
    f.provider.runSetupCommand = async () => undefined;
    const intent = await f.owner.prepareIntent("development", { emptyWorkspace: true });
    expect(intent.profileSnapshot).not.toHaveProperty("project");
    expect(intent.profileSnapshot).not.toHaveProperty("runtimePreparation");
    expect(f.spies.prepareNodeArtifacts).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "retains exact project-image selection only for provider opt-in=%s",
    async (enabled) => {
      const f = await fixture();
      support.getDevelopmentProfile().retention = {
        mode: "session-disk",
        computeWindowSeconds: 14400,
      };
      f.provider.supportsRetainedProjectImages = () => enabled;
      const intent = await f.owner.prepareIntent("development", {
        projectPath: f.projectPath,
        setupAuthorized: true,
      });
      const preparation = readWorkerProjectPreparation(intent.profileSnapshot.project);
      if (enabled) {
        expect(intent.profileSnapshot.project).toMatchObject({
          root: f.projectPath,
          baseCommit: await requireGit(f.projectPath, ["rev-parse", "HEAD"]),
        });
        expect(preparation?.key).toBe(readWorkerPreparation(intent.profileSnapshot)?.key);
        expect(preparation?.cacheKey).toMatch(/^[a-f0-9]{64}$/u);
      } else {
        expect(intent.profileSnapshot.project).toBeUndefined();
        expect(preparation).toBeUndefined();
      }
    },
  );
  it.each([
    { archived: true, os: undefined, revoke: false, deny: false, preclaim: true, closed: false },
    { archived: true, os: undefined, revoke: false, deny: false, preclaim: true, closed: true },
    { archived: false, os: undefined, revoke: false, deny: false, preclaim: false, closed: false },
    { archived: true, os: "darwin", revoke: false, deny: false, preclaim: false, closed: false },
    { archived: true, os: "darwin", revoke: true, deny: false, preclaim: false, closed: false },
    { archived: true, os: "darwin", revoke: false, deny: true, preclaim: false, closed: false },
  ])(
    "composes image redispatch through a fresh lease without inherited authority ($archived/$os/$revoke/$deny/preclaim=$preclaim/closed=$closed)",
    async ({ archived, os, revoke, deny, preclaim, closed }) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", support.testState.root);
      onTestFinished(() => {
        policy.current = undefined;
      });
      policy.current = {
        version: 1,
        preparedCapacity: "image",
        resolveConnectionIdentity: () => undefined,
        withIdentity: async () => {
          throw new Error("Repository operation before current input admission");
        },
      };
      vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", "synthetic-password");
      const profile = ensureProfileForEmail("github:ghe.example.test:101");
      const catalog = await prepareUserProfileCatalog();
      onTestFinished(() => catalog.release());
      support.testState.config.gateway = {
        github: { host: "ghe.example.test", apiBaseUrl: "https://api.ghe.example.test" },
        nodes: { commands: { allow: ["codex.exec-server.stdio.v1"] } },
      };
      support.testState.config.tools = {
        github: {
          kind: "app-installation",
          profileId: "ghp_6128c113c0df8c1a366dfe690c062d8e",
          app: {
            appId: 10,
            installationId: 20,
            accountId: 30,
            repositories: [{ id: 40, fullName: "example/project" }],
            permissions: { contents: "write" },
            privateKey: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
              type: "pkcs8",
              format: "pem",
            }),
            keyVersion: "v1",
          },
        },
      };
      setRuntimeConfigSnapshot(support.testState.config);
      const features = [
        WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
        WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE,
      ];
      const bundle = { ...support.BUNDLE_ARTIFACT, protocolFeatures: features };
      vi.mocked(support.testState.prepareInstallation).mockResolvedValue(bundle);
      const receipt = { ...support.BOOTSTRAP_RECEIPT, protocolFeatures: features };
      const target = vi.fn<NonNullable<WorkerProvider["resolvePreparationTarget"]>>(
        (_settings, machineClass, selectedOs) => ({
          machineClass: machineClass ?? "small",
          platform: selectedOs ?? "linux",
        }),
      );
      const provision = vi.fn<WorkerProvider["provision"]>(
        async (_settings, _operation, options) => {
          const enrollment = await options!.beginNodeEnrollment!();
          if (enrollment.mode !== "connect") {
            throw new Error("Expected fresh enrollment");
          }
          await completeWorkerNodeSetupForTest({
            baseDir: support.testState.root,
            store: support.testState.store,
            setupId: enrollment.setupId,
            deviceId: "node-1",
            completedAtMs: support.testState.nowMs,
          });
          return {
            leaseId: "fresh-selector-lease",
            node: { deviceId: await enrollment.waitForDeviceId() },
            sharedHost: false,
          };
        },
      );
      const provider = support.createProvider({
        inspect: async (lease) =>
          preclaim && lease.leaseId === "retired-selector-lease"
            ? { status: "unknown" }
            : { status: "active", sharedHost: false },
        requiresNodeEnrollment: true,
        supportsProjectPreparation: () => true,
        resolvePreparationTarget: target,
        resolveAllocation: async () => ({ leaseId: "fresh-selector-lease", sharedHost: false }),
        provision,
      });
      let authorized = true;
      let preparingReplacement = false;
      let artifactPreparations = 0;
      const assertCurrent = () => {
        if (!authorized) {
          throw new Error("Current input authority revoked");
        }
      };
      const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
      const service = support.createService(provider, {
        placementStore: createWorkerSessionPlacementGate(placements),
        projectNamespace: "selector-composition",
        prepareNodeArtifacts: async () => {
          artifactPreparations++;
          if (preparingReplacement && revoke) {
            authorized = false;
          }
          return {
            artifacts: {
              nodeBootstrapSha256: support.NODE_BOOTSTRAP.sha256,
              enabledPluginIds: [],
              workerBundleHash: bundle.bundleHash,
              workerArchiveSha256: bundle.tarballSha256,
              openclawVersion: bundle.openclawVersion,
              protocolFeatures: features,
            },
            assertCurrent: () => {},
          };
        },
        prepareNodeEnrollment: async (record) => {
          const pending = await support.testState.store.ensureNodeEnrollment(record.environmentId);
          if (!pending.nodeSetupId) {
            throw new Error("Expected pending setup");
          }
          return {
            mode: "connect",
            setupId: pending.nodeSetupId,
            setupCode: "synthetic",
            displayName: "Fixture node",
            openclawVersion: bundle.openclawVersion,
            nodeBootstrap: support.NODE_BOOTSTRAP,
            waitForDeviceId: async () => "node-1",
          };
        },
        ensureNodeWorkerBundle: async ({ assertCurrent: check }) => {
          check?.();
          return receipt;
        },
      });
      const store = support.testState.store;
      const identity = { ...REQUEST, executionMode: "remote-exec" as const };
      const initial = await service.prepareProjectIntent(REQUEST.profileId, {
        imageReserve: true,
        machineClass: "large",
        os,
        executionMode: identity.executionMode,
      });
      const originalArchive = JSON.stringify(initial.profileSnapshot);
      const oldSnapshot = {
        ...requireWorkerProfile(initial.profileSnapshot),
        ...(archived ? { historicalProfileSnapshotJson: originalArchive } : {}),
      };
      await store.createIntent({
        environmentId: "retired-selector-environment",
        profileId: REQUEST.profileId,
        providerId: provider.id,
        profileSnapshot: oldSnapshot,
        provisionOperationId: "retired-selector-intent",
      });
      await store.transition({
        environmentId: "retired-selector-environment",
        from: "requested",
        to: "provisioning",
      });
      const ready = await store.transition({
        environmentId: "retired-selector-environment",
        from: "provisioning",
        to: "ready",
        patch: {
          leaseId: "retired-selector-lease",
          sharedHost: false,
          nodeDeviceId: "retired-node",
          ...support.readyPatch("retired-selector-environment", receipt),
        },
      });
      const attached = await service.attachSession({
        environmentId: ready.environmentId,
        ownerEpoch: ready.ownerEpoch,
        sessionId: identity.sessionId,
      });
      await advancePlacementFixtureToActive(placements, support.testState.stateDb, identity, {
        environmentId: ready.environmentId,
        ownerEpoch: attached.ownerEpoch,
        workerBundleHash: bundle.bundleHash,
        seedEnvironment: false,
      });
      const active = placements.get(identity.sessionId);
      if (active?.state !== "active") {
        throw new Error("Expected active original placement");
      }
      let reclaimed:
        | Extract<
            import("./placement-store.js").WorkerSessionPlacementRecord,
            { state: "reclaimed" }
          >
        | undefined;
      if (!preclaim) {
        const draining = await placements.startDrain({
          sessionId: identity.sessionId,
          environmentId: ready.environmentId,
          ownerEpoch: attached.ownerEpoch,
          expectedGeneration: active.generation,
        });
        const reconciling = await placements.startReconcile({
          sessionId: identity.sessionId,
          environmentId: ready.environmentId,
          ownerEpoch: attached.ownerEpoch,
          expectedGeneration: draining.generation,
        });
        const transition = await placements.transition({
          sessionId: identity.sessionId,
          from: "reconciling",
          to: "reclaimed",
          expectedGeneration: reconciling.generation,
        });
        if (transition.state !== "reclaimed") {
          throw new Error("Expected reclaimed fixture");
        }
        reclaimed = transition;
        await service.destroy(ready.environmentId);
      }
      const repository = await getSessionRepositoryWorkspaceStore().create({
        agentId: identity.agentId,
        sessionKey: identity.sessionKey,
        url: "https://ghe.example.test/example/project.git",
        runSetupScript: false,
        assertCurrent,
      });
      const createWithRequest = vi.spyOn(service, "createWithRequest");
      const harness = await createHarness(support.testState.stateDb, placements, {
        environmentService: service,
        requiresNodeEnrollment: true,
        resolveWorkspace: async () => ({ kind: "repository", repository }),
      });
      const admittedNode = await transport().getCurrentNode("node-1");
      if (!admittedNode) {
        throw new Error("Expected fixture node proof");
      }
      const node = {
        ...admittedNode,
        commands: ["codex.exec-server.stdio.v1"],
      };
      bindDeviceWorkerAvailability(harness.environments, async () => ({ available: true, node }));
      const nodeStaging = path.join(support.testState.root, "node-staging");
      let baseline: Awaited<ReturnType<typeof prepareNodeWorkspaceTransferSnapshot>> | undefined;
      if (preclaim) {
        await fs.mkdir(nodeStaging);
        await fs.mkdir(path.join(support.testState.root, "snapshots"));
        await requireGit(nodeStaging, ["init", "--quiet"]);
        await requireGit(nodeStaging, [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "--allow-empty",
          "--quiet",
          "-m",
          "base",
        ]);
        baseline = await prepareNodeWorkspaceTransferSnapshot({
          localPath: nodeStaging,
          temporaryRoot: path.join(support.testState.root, "snapshots"),
        });
      }
      const manifestRef = baseline?.manifestRef ?? `sha256:${"b".repeat(64)}`;
      const startedEnvironments: string[] = [];
      vi.spyOn(service, "startTunnel").mockImplementation(async (request) => {
        if (preclaim && request.environmentId === ready.environmentId) {
          throw new Error("Expired old worker must not execute");
        }
        startedEnvironments.push(request.environmentId);
        return {
          ...createWorkerTurnTunnel({
            launchTurn: vi.fn(),
            runWorkspaceCommand: async () => ({
              termination: "exit",
              code: 0,
              signal: null,
              killed: false,
              stdout: "",
              stderr: "",
            }),
            quiesceWorkspace: async () => ({
              assertActive: async () => {},
              resume: async () => {},
            }),
            reconcileWorkspace: async (input) => {
              if (input.source.kind !== "repository") {
                throw new Error("Expected repository transfer");
              }
              if (!input.source.authorize) {
                throw new Error("Expected repository transfer authority");
              }
              input.source.authorize();
              const checkpoint = baseline
                ? await input.source.prepareCheckpoint({
                    stagingRoot: nodeStaging,
                    baseManifestRaw: baseline.rawManifest,
                    currentManifestRaw: baseline.rawManifest,
                    baseManifestRef: baseline.manifestRef,
                    currentManifestRef: baseline.manifestRef,
                  })
                : undefined;
              return {
                manifestRef,
                changed: false,
                verifyStable: async () => {},
                verifyLocalStable: async () => {
                  await checkpoint?.verify();
                },
                publishStagedResult: async () => {
                  await checkpoint?.publish();
                },
                discardPreparedStagedResult: async () => {
                  await checkpoint?.discard();
                },
              };
            },
          }),
          environmentId: request.environmentId,
          ownerEpoch: request.ownerEpoch!,
          syncWorkspace: async (input) => {
            input.authorize?.();
            return {
              mode: "repository",
              remoteWorkspaceDir: "/fixture/workspace",
              manifestRef,
              baseCommit: baseline?.manifest.baseCommit ?? "e".repeat(40),
              baseManifestRef: manifestRef,
            };
          },
        };
      });
      // Harness copied the service before this node-transport fixture was installed.
      harness.environments.startTunnel = service.startTunnel;
      let redemptions = 0;
      policy.current = {
        version: 1,
        preparedCapacity: "image",
        resolveConnectionIdentity: () => undefined,
        async withIdentity(context, run) {
          context.assertCurrent();
          expect(context.actor).toMatchObject({ actorId: 101, profileId: profile.id });
          expect(context.operation).toMatchObject({
            purpose: "session-dispatch-project",
            binding: { sessionId: identity.sessionId },
          });
          return run({
            env: context.env,
            assertCurrent: context.assertCurrent,
            readNativeCredential: async (_env, admission) => {
              context.assertCurrent();
              expect(admission).toMatchObject({ kind: "repository-admission" });
              redemptions++;
              expect(provision).toHaveBeenCalledOnce();
              if (deny) {
                throw new Error("Repository integration admission failed");
              }
              return undefined;
            },
          });
        },
      };
      const fetch = vi.fn(async (url: string, options: RequestInit) => {
        const route = new URL(url).pathname + new URL(url).search;
        if (options.method === "DELETE") {
          return new Response(null, { status: 204 });
        }
        const permissions = { contents: "write", metadata: "read" };
        const bodies: Record<string, unknown> = {
          "/app": { id: 10, slug: "fixture", permissions },
          "/app/installations/20": {
            id: 20,
            app_id: 10,
            account: { id: 30 },
            suspended_at: null,
            permissions,
          },
          "/app/installations/20/access_tokens": {
            token: "synthetic-installation-token",
            expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
            permissions,
          },
          "/users/fixture%5Bbot%5D": {
            id: 50,
            login: "fixture[bot]",
            type: "Bot",
            avatar_url: null,
          },
          "/installation/repositories?per_page=100": {
            total_count: 1,
            repositories: [{ id: 40, full_name: "example/project" }],
          },
        };
        if (!bodies[route]) {
          throw new Error("Unexpected fixture issuer request");
        }
        return Response.json(bodies[route]);
      });
      vi.stubGlobal("fetch", fetch);
      const client: GatewayClient = {
        connId: "provider-intent-operator",
        authenticatedUserId: "github:ghe.example.test:101",
        connect: {
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
          client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
          role: "operator",
          scopes: ["operator.admin"],
        },
        authenticatedGitHubAccountId: 101,
        authenticatedRepositoryCredentialSource: Object.freeze({
          id: `browser:${"b".repeat(64)}`,
          expiresAtMs: Date.now() + 300_000,
        }),
        authenticatedUserProfile: {
          profileId: profile.id,
          displayName: null,
          hasAvatar: false,
          updatedAt: profile.updatedAt,
        },
        internal: { authenticatedOperator: true },
      };
      const redispatch = createWorkerPlacementRedispatch({
        placements,
        dispatch: harness.service.dispatch,
        resolveDevicePlacementRequirement: async () => ({
          requiredNodeCommands: ["codex.exec-server.stdio.v1"],
          consumesWorkerSlot: false,
        }),
      });
      preparingReplacement = true;
      const runLocal = vi.fn(async () => {
        if (closed) {
          throw new Error("codex app-server client closed before turn completed");
        }
        return { payloads: [{ text: "fresh input completed" }], meta: { durationMs: 1 } };
      });
      const launcher = createWorkerSessionTurnPlacementProvider({
        environments: service,
        placements,
        reconcileActivePlacement: async (environmentId) =>
          harness.service.reconcileActive(environmentId),
        redispatchPlacement: redispatch,
        waitForAdmissionNode: async ({ placement, assertCurrent: assertAdmissionCurrent }) => {
          assertAdmissionCurrent();
          if (placement.environmentId === ready.environmentId) {
            throw new Error("Expired lease cannot reconnect");
          }
        },
        resolveWorkspace: async () => {
          const current = await getSessionRepositoryWorkspaceStore().get(repository.workspaceId);
          if (!current) {
            throw new Error("Repository fixture disappeared");
          }
          return { kind: "repository", repository: current };
        },
        workspaceOperations: createWorkerWorkspaceOperationCoordinator(),
      });
      const sessionTarget = {
        ...identity,
        storePath: path.join(support.testState.root, "sessions.json"),
      };
      if (preclaim) {
        support.testState.config.session = { store: sessionTarget.storePath };
        const entry = { sessionId: identity.sessionId, updatedAt: Date.now() };
        await patchSessionEntryCore(sessionTarget, () => entry, {
          fallbackEntry: entry,
          skipMaintenance: true,
        });
        setWorkerTurnSessionTarget(sessionTarget);
      }
      try {
        const dispatching = withRepositoryChatDispatch(
          {
            client,
            ...identity,
            getSessionId: () => identity.sessionId,
            runId: "fresh-selector-input",
            assertCurrent,
          },
          async () => {
            if (!preclaim) {
              if (!reclaimed) {
                throw new Error("Expected reclaimed fixture");
              }
              return redispatch(reclaimed, { assertCurrent });
            }
            const input = {
              ...turn("fresh-selector-input"),
              ...identity,
              sessionTarget,
              sessionFile: identity.sessionKey,
              workspaceDir: support.testState.root,
              sessionRoot: support.testState.root,
              config: support.testState.config,
            };
            await launcher.executeTurn(
              { ...identity, runId: "fresh-selector-input" },
              input,
              runLocal,
              undefined,
              assertCurrent,
            );
            expect(runLocal).toHaveBeenCalledOnce();
            expect(startedEnvironments).not.toContain(ready.environmentId);
            return placements.getAsync(identity.sessionId);
          },
        );
        if (revoke || deny || closed) {
          await expect(dispatching).rejects.toThrow(
            revoke
              ? "Current input authority revoked"
              : closed
                ? "codex app-server client closed"
                : "Repository integration admission failed",
          );
        } else {
          await expect(dispatching).resolves.toMatchObject({
            state: "active",
            sessionId: identity.sessionId,
          });
        }
        if (preclaim) {
          expect(runLocal).toHaveBeenCalledOnce();
        }
        expect(provision).toHaveBeenCalledTimes(revoke ? 0 : 1);
        expect(artifactPreparations).toBe(2);
        expect(redemptions).toBe(revoke ? 0 : 1);
        expect(store.get(ready.environmentId)?.profileSnapshot).toEqual(oldSnapshot);
        const fresh = store.list().filter((row) => row.environmentId !== ready.environmentId);
        expect(fresh).toHaveLength(revoke ? 0 : 1);
        if (!revoke) {
          expect(fresh[0]?.leaseId).toBe("fresh-selector-lease");
          expect(fresh[0]?.profileSnapshot).toMatchObject({
            machineClass: "large",
            executionMode: "remote-exec",
            runtimePreparation: {
              source: "image",
              target: { machineClass: "large", platform: os ?? "linux" },
            },
          });
          expect(fresh[0]?.profileSnapshot.historicalProfileSnapshotJson).toBeUndefined();
          expect(fresh[0]?.profileSnapshot.os).toBe(os);
          expect(readWorkerPreparation(fresh[0]!.profileSnapshot)?.key).toBe(
            readWorkerPreparation(initial.profileSnapshot)?.key,
          );
          if (!deny && !closed) {
            const admittedAllocation = createWithRequest.mock.calls[0]?.[0];
            if (!admittedAllocation) {
              throw new Error("Expected a fresh allocation request");
            }
            const repeat = await service.createWithRequest(admittedAllocation);
            expect(repeat.environmentId).toBe(fresh[0]?.environmentId);
            expect(provision).toHaveBeenCalledOnce();
            expect(redemptions).toBe(1);
          }
        }
        expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([]);
        expect(placements.get(identity.sessionId)?.turnClaim).toBeNull();
      } finally {
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
      }
    },
  );

  it("admits runtime image capacity without repository reads and retains its source across replay", async () => {
    const f = await fixture();
    const readNativeCredential = vi.fn(async () => {
      throw new Error("repository credential must not be read");
    });
    const intent = await f.owner.prepareIntent("development", {
      imageReserve: true,
      readNativeCredential,
    });
    expect(intent.profileSnapshot.project).toBeUndefined();
    expect(workerPreparationSourceKey(intent.profileSnapshot)).toBe("image");
    expect(readWorkerPreparation(intent.profileSnapshot)?.key).toMatch(/^[a-f0-9]{64}$/u);
    expect(f.prepareNodeArtifacts).toHaveBeenCalledOnce();
    expect(readNativeCredential).not.toHaveBeenCalled();
    const record = await f.owner.createWithProfile(
      "development",
      "image-intent",
      { imageReserve: true },
      intent,
    );
    expect(
      (await f.owner.createWithProfile("development", "image-intent")).profileSnapshot,
    ).toEqual(record.profileSnapshot);
    await expect(
      f.owner.createWithProfile("development", "image-intent", { emptyWorkspace: true }),
    ).rejects.toThrow("another project preparation");
    const retained = await f.owner.prepareRetention(
      record,
      readWorkerPreparation(record.profileSnapshot)!,
    );
    expect(retained?.isCurrent()).toBe(true);
    f.target.mockReturnValue({ machineClass: "large", platform: "linux", arch: "amd64" });
    expect(retained?.isCurrent()).toBe(false);
    expect(() => f.owner.assertPreparedIntentCurrent("development", intent)).toThrow(
      "preparation changed",
    );
    expect(readNativeCredential).not.toHaveBeenCalled();
  });

  it.each(["node", "target", "preparation"] as const)(
    "refuses runtime image capacity without provider %s support",
    async (missing) => {
      const f = await fixture();
      if (missing === "node") {
        f.provider.requiresNodeEnrollment = false;
      }
      if (missing === "target") {
        f.provider.resolvePreparationTarget = undefined;
      }
      if (missing === "preparation") {
        f.provider.supportsProjectPreparation = undefined;
      }
      await expect(f.owner.prepareIntent("development", { imageReserve: true })).rejects.toThrow(
        "cannot prepare runtime-only image capacity",
      );
      expect(f.resumeProvision).not.toHaveBeenCalled();
    },
  );

  it("rejects mixed image and repository sources before artifact preparation", async () => {
    const f = await fixture();
    await expect(
      f.owner.prepareIntent("development", {
        imageReserve: true,
        repository: { agentId: "main", url: "https://github.com/acme/project.git" },
      }),
    ).rejects.toThrow("exactly one project source");
    expect(f.prepareNodeArtifacts).not.toHaveBeenCalled();
  });

  it("admits repository intent and human presence for a cold Sandbox disk", async () => {
    let registered: WorkerProvider | undefined;
    const { register } = resolvePluginModuleExport(
      await importFreshModule<unknown>(import.meta.url, "../../../extensions/crabbox/index.ts"),
    );
    if (!register) {
      throw new Error("Crabbox plugin registration is unavailable");
    }
    register(
      createTestPluginApi({
        registerWorkerProvider: (provider) => {
          registered = provider;
        },
      }),
    );
    if (!registered) {
      throw new Error("Crabbox provider was not registered");
    }
    const provider = registered;
    const f = await fixture(false, provider);
    const profile = support.testState.config.cloudWorkers!.profiles!.development!;
    profile.provider = "crabbox";
    profile.readyWorkers = 1;
    profile.settings = {
      provider: "azure-sandbox",
      class: "small",
      ttl: "4h",
      idleTimeout: "60m",
      warmImage: false,
      azureSandboxDiskId: "synthetic-private-disk",
    };
    const image = await f.owner.prepareIntent("development", {
      imageReserve: true,
      executionMode: "remote-exec",
    });
    const inherited = await f.owner.prepareIntent("development", {
      imageReserve: true,
      executionMode: "remote-exec",
      inherited: { providerId: "crabbox", profileSnapshot: image.profileSnapshot },
    });
    expect(readWorkerPreparation(inherited.profileSnapshot)).toMatchObject({
      source: "image",
      target: { machineClass: "small", platform: "linux" },
    });
    const commit = "a".repeat(40);
    const tree = "b".repeat(40);
    const repository = { agentId: "main", url: "https://github.com/acme/project.git", ref: "main" };
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(new Request(input).url);
      const value =
        url.pathname === "/repos/acme/project"
          ? {
              node_id: "R_synthetic_project",
              clone_url: repository.url,
              private: false,
              default_branch: "main",
            }
          : url.pathname.includes("/commits/")
            ? { sha: commit, commit: { tree: { sha: tree } } }
            : url.pathname.includes("/git/trees/")
              ? { sha: tree, truncated: false, tree: [] }
              : undefined;
      if (!value) {
        throw new Error(`Unexpected GitHub request: ${url.pathname}`);
      }
      return new Response(JSON.stringify(value), {
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchImpl);
    let persisted: PreparedPoolPresenceDemand | undefined;
    const presence = createPreparedPoolPresence({
      store: support.testState.store,
      getConfig: () => support.testState.config,
      prepareIntent: (profileId, options) =>
        f.owner.prepareIntent(profileId, {
          ...options,
          // The anonymous credential fixture never consults operator GitHub credentials.
          readNativeCredential: async () => undefined,
        }),
      assertIntentCurrent: f.owner.assertPreparedIntentCurrent,
      resolveHumanPresenceDemand: () => ({
        profileId: "development",
        executionMode: "remote-exec",
        repository,
      }),
      presenceDemandStore: {
        read: async () => persisted,
        write: async (value, assertCurrent) => {
          assertCurrent();
          persisted = value ?? undefined;
          return persisted;
        },
      },
      now: () => 1000,
      signal: new AbortController().signal,
      schedule: async () => {},
    });
    try {
      await presence.set(true);
      const demand = await presence.maintain();
      expect(demand?.project).toMatchObject({
        source: { url: repository.url },
        baseCommit: commit,
      });
      expect(demand?.preparationKey).toMatch(/^[a-f0-9]{64}$/u);
      expect(support.testState.store.list()).toHaveLength(1);
      expect(support.testState.store.list()[0]?.preparation).toMatchObject({
        purpose: "reserve",
        key: demand?.preparationKey,
      });
      expect(f.resumeProvision).not.toHaveBeenCalled();
      const controller = new AbortController();
      const requestIntent = await f.owner.prepareIntent("development", {
        repository,
        executionMode: "remote-exec",
        signal: controller.signal,
        readNativeCredential: async () => undefined,
      });
      expect(() => f.owner.assertPreparedIntentCurrent("development", requestIntent)).not.toThrow();
      controller.abort();
      expect(() => f.owner.assertPreparedIntentCurrent("development", requestIntent)).toThrow();
      expect(f.resumeProvision).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("admits exact local source and OS without allocating, and retains reusable facts after caller abort", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const options = { machineClass: "large", os: "linux", signal: controller.signal };
    const intent = await f.prepare(options);
    expect(intent.profileSnapshot.project?.preparation?.key).toMatch(/^[a-f0-9]{64}$/u);
    expect(f.spies.target).toHaveBeenCalledWith({ region: "test" }, "large", "linux");
    expect(support.testState.store.list()).toEqual([]);
    expect(f.spies.resumeProvision).not.toHaveBeenCalled();
    controller.abort();
    expect(() => f.owner.assertPreparedIntentCurrent("development", intent)).not.toThrow();
    await f.create("admitted-local", { ...options, signal: undefined }, intent);
    expect(support.testState.store.list()).toHaveLength(1);
    expect(f.spies.resumeProvision).toHaveBeenCalledOnce();
  });

  it("replays a removed linked source through its canonical repository while rejecting other projects and commits", async () => {
    const f = await fixture();
    const linked = path.join(support.testState.root, "linked-source");
    await requireGit(f.projectPath, ["worktree", "add", "--detach", linked, "HEAD"]);
    await fs.writeFile(path.join(linked, "input.txt"), "session commit\n");
    await requireGit(linked, ["commit", "--quiet", "-am", "session"]);
    const options = { projectPath: linked };
    const admitted = await f.prepare(options);
    const stored = await f.create("linked-replay", options, admitted);
    await fs.writeFile(path.join(f.projectPath, "input.txt"), "new primary commit\n");
    await requireGit(f.projectPath, ["commit", "--quiet", "-am", "advance primary"]);
    const primaryCommit = await requireGit(f.projectPath, ["rev-parse", "HEAD"]);
    await requireGit(f.projectPath, ["worktree", "remove", linked]);

    const replayed = {
      environmentId: stored.environmentId,
      profileSnapshot: stored.profileSnapshot,
    };
    await expect(f.create("linked-replay")).resolves.toMatchObject(replayed);
    const nested = path.join(f.projectPath, "nested");
    await fs.mkdir(nested);
    await expect(f.create("linked-replay", { projectPath: nested })).resolves.toMatchObject(
      replayed,
    );
    expect((await f.prepare({ projectPath: nested })).profileSnapshot.project).toBeUndefined();

    const other = path.join(support.testState.root, "other-clone");
    await requireGit(support.testState.root, ["clone", "--no-hardlinks", f.projectPath, other]);
    await expect(f.create("linked-replay", { projectPath: other })).rejects.toThrow(
      "Idempotency key belongs to another project",
    );
    await expect(f.create("linked-replay", { projectCommit: primaryCommit })).rejects.toThrow(
      "Idempotency key belongs to another project preparation",
    );
    const changed = await f.prepare();
    await expect(f.create("linked-replay", {}, changed)).rejects.toThrow(
      "Idempotency key belongs to another project preparation",
    );
    expect(support.testState.store.get(stored.environmentId)?.profileSnapshot).toEqual(
      stored.profileSnapshot,
    );
    expect(f.spies.resumeProvision).toHaveBeenCalledTimes(3);
  });

  it.each([false, true])(
    "preserves setup authority and configured skip policy (skip=%s)",
    async (skip) => {
      const f = await fixture(true);
      if (skip) {
        support.getDevelopmentProfile().runSetupScript = false;
      }
      const ordinary = await f.owner.prepareIntent("development", { projectPath: f.projectPath });
      expect(Boolean(readWorkerPreparation(ordinary.profileSnapshot)?.key)).toBe(skip);
      const authorized = await f.owner.prepareIntent("development", {
        projectPath: f.projectPath,
        setupAuthorized: true,
      });
      const skipped = await f.owner.prepareIntent("development", {
        projectPath: f.projectPath,
        runSetupScript: false,
      });
      expect(readWorkerPreparation(authorized.profileSnapshot)?.key).toBeDefined();
      expect(readWorkerPreparation(skipped.profileSnapshot)?.key).toBeDefined();
      if (skip) {
        expect(readWorkerPreparation(skipped.profileSnapshot)?.key).toBe(
          readWorkerPreparation(authorized.profileSnapshot)?.key,
        );
        expect(
          readWorkerProjectPreparation(authorized.profileSnapshot.project)?.runSetupScript,
        ).toBe(false);
      } else {
        expect(readWorkerPreparation(skipped.profileSnapshot)?.key).not.toBe(
          readWorkerPreparation(authorized.profileSnapshot)?.key,
        );
      }
      await f.owner.createWithProfile("development", "session-setup", {
        projectPath: f.projectPath,
        runSetupScript: true,
      });
      expect(
        readWorkerProjectPreparation(support.testState.store.list()[0]!.profileSnapshot.project)
          ?.key,
      ).toBe(readWorkerPreparation(authorized.profileSnapshot)?.key);
      if (skip) {
        expect(support.testState.store.list()[0]!.profileSnapshot.runSetupScript).toBe(false);
        expect(
          readWorkerProjectPreparation(support.testState.store.list()[0]!.profileSnapshot.project)
            ?.runSetupScript,
        ).toBe(false);
      }
    },
  );
});
