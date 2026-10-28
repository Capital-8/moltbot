import { EventEmitter } from "node:events";
import vm from "node:vm";
import { onTestFinished, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import {
  WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE,
  WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { getRuntimeConfig } from "../../config/config.js";
import {
  NODE_WORKER_ENVIRONMENT_SESSION_VERSION,
  NODE_WORKER_PREPARED_WORKSPACE_VERSION,
  NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
} from "../../infra/node-runner-inventory.js";
import type { SessionRepositoryWorkspaceRecord } from "../../state/session-repository-workspaces.types.js";
import type { NodeWorkerPreparedWorkspaceResult } from "../../worker/node-workspace-prepared-protocol.js";
import {
  createNodeRegistryRuntime,
  updateNodeRunnerInventory,
  type NodeWorkerSupervisorNodeProof,
} from "../node-registry-private.js";
import { NodeRegistry } from "../node-registry.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import { bindDeviceWorkerAvailability } from "./device-provider.js";
import type { EnvironmentRecipe } from "./environment-recipe.js";
import { REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import type { WorkerPlacementExecutionMode } from "./placement-record.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import type { WorkerProviderPreparedIntent } from "./preparation-identity.js";
import type { WorkerProjectPreparationIdentity } from "./preparation-identity.schema.js";
import * as support from "./service.test-support.js";
import type { WorkerProjectSnapshot } from "./workspace-git-base.js";

const PREPARATION_KEY = "c".repeat(64);
export const FEATURES = [
  WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
  WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE,
];

export async function preparedHarness(
  options: {
    reserve?: boolean;
    placements?: ReturnType<typeof createWorkerSessionPlacementStore>;
    protocolFeatures?: string[];
    executionMode?: WorkerPlacementExecutionMode;
    emptyWorkspace?: boolean;
    imageReserve?: boolean;
    repository?: SessionRepositoryWorkspaceRecord;
    recipe?: EnvironmentRecipe;
    lifecycleFailure?: boolean;
    boundWorkspace?: Pick<
      NodeWorkerPreparedWorkspaceResult,
      "workspaceDir" | "sourceManifestRef" | "preparedManifestRef"
    >;
  } = {},
) {
  const protocolFeatures = options.protocolFeatures ?? FEATURES;
  const executionMode = options.executionMode ?? "worker-turn";
  const reserve = options.reserve !== false;
  let nodeCurrent = true;
  const placements =
    options.placements ??
    createWorkerSessionPlacementStore({
      database: support.testState.stateDb,
      now: () => support.testState.nowMs,
    });
  const harness = await createHarness(support.testState.stateDb, placements, {
    ...(options.repository
      ? {
          requiresNodeEnrollment: true,
          resolveWorkspace: async () => ({ kind: "repository", repository: options.repository! }),
        }
      : {}),
    isCurrentNodePlacement: (proof, requirement, mode) =>
      nodeCurrent &&
      transport.isCurrent(
        proof,
        requirement.consumesWorkerSlot,
        requirement.requiredNodeCommands,
        mode === "worker-turn",
      ),
  });
  const environmentId = reserve ? "prepared-spare" : harness.ready.environmentId;
  const preparation: WorkerProjectPreparationIdentity = {
    key: PREPARATION_KEY,
    cacheKey: "a".repeat(64),
    contractVersion: 1,
    target: { machineClass: "standard", platform: "linux", arch: "x64" },
    artifacts: {
      nodeBootstrapSha256: "f".repeat(64),
      enabledPluginIds: [],
      workerBundleHash: support.BUNDLE_HASH,
      workerArchiveSha256: "b".repeat(64),
      openclawVersion: support.BOOTSTRAP_RECEIPT.openclawVersion,
      protocolFeatures,
    },
  };
  const repositoryBaseCommit = options.repository?.baseCommit;
  if (options.repository && !options.imageReserve && !repositoryBaseCommit) {
    throw new Error("Prepared repository fixture requires its accepted base commit");
  }
  const project: WorkerProjectSnapshot =
    options.repository && repositoryBaseCommit
      ? {
          key: "d".repeat(64),
          baseCommit: repositoryBaseCommit,
          source: {
            kind: "repository",
            url: options.repository.url,
            repositoryId: "R_dispatch_fixture",
            owner: {
              agent: { agentId: REQUEST.agentId, provenance: null },
              identity: { source: "anonymous" },
            },
          },
        }
      : { key: "d".repeat(64), baseCommit: "e".repeat(40), root: "/gateway/workspace" };
  const profile = { settings: { region: "test" }, executionMode };
  const intent: WorkerProviderPreparedIntent = {
    providerId: "fake",
    profileSnapshot:
      options.emptyWorkspace || options.imageReserve
        ? {
            ...profile,
            runtimePreparation: {
              ...preparation,
              source: options.imageReserve ? "image" : "empty",
            },
          }
        : {
            ...profile,
            project: {
              ...project,
              preparation: {
                ...preparation,
                ...(options.recipe
                  ? { recipe: options.recipe, setupRecipe: options.recipe.identity }
                  : {}),
              },
            },
          },
  };
  const store = support.testState.store;
  await store.createIntent({
    environmentId,
    profileId: REQUEST.profileId,
    providerId: intent.providerId,
    profileSnapshot: intent.profileSnapshot,
    provisionOperationId: `provision:${environmentId}`,
    ...(reserve
      ? {
          preparation: {
            purpose: "reserve",
            key: PREPARATION_KEY,
            demandAtMs: 900,
            expiresAtMs: 10_000,
          },
        }
      : {}),
  });
  await store.transition({ environmentId, from: "requested", to: "provisioning" });
  const ready = await store.transition({
    environmentId,
    from: "provisioning",
    to: "ready",
    patch: {
      leaseId: `lease:${environmentId}`,
      nodeDeviceId: "prepared-node",
      sharedHost: false,
      ...support.readyPatch(environmentId, {
        ...support.BOOTSTRAP_RECEIPT,
        protocolFeatures,
      }),
    },
  });
  vi.mocked(support.testState.prepareInstallation).mockResolvedValue({
    ...support.BUNDLE_ARTIFACT,
    protocolFeatures,
  });
  const workerService = support.createService(support.createProvider());
  const projected = workerService.get(environmentId)!;
  const ordinaryGet = vi.mocked(harness.environments.get).getMockImplementation()!;
  vi.mocked(harness.environments.get).mockImplementation(
    (id) => workerService.get(id) ?? ordinaryGet(id),
  );
  vi.mocked(harness.environments.prepareProjectIntent).mockResolvedValue(intent);
  vi.mocked(harness.environments.getPreparedCandidates).mockReturnValue(reserve ? [projected] : []);
  const ordinaryAttach = vi.mocked(harness.environments.attachSession).getMockImplementation()!;
  vi.mocked(harness.environments.attachSession).mockImplementation(async (request) => {
    const credential =
      request.environmentId === environmentId
        ? await workerService.attachSession(request)
        : undefined;
    const ordinary = await ordinaryAttach(request);
    return credential ?? ordinary;
  });
  const ordinaryDestroy = vi.mocked(harness.environments.destroy).getMockImplementation()!;
  vi.mocked(harness.environments.destroy).mockImplementation(async (id) =>
    id === environmentId ? await workerService.destroy(id) : await ordinaryDestroy(id),
  );
  const ordinaryTunnel = vi.mocked(harness.environments.startTunnel).getMockImplementation()!;
  vi.mocked(harness.environments.startTunnel).mockImplementation(async (request) => {
    const tunnel = await ordinaryTunnel(request);
    if (options.recipe) {
      vi.spyOn(tunnel, "runWorkspaceCommand").mockImplementation(async (command) => {
        command.assertCurrent?.();
        const process = Object.assign(new EventEmitter(), {
          env: { PATH: "/worker/bin", HOME: "/worker/home" },
          cwd: () => "/worker/workspace",
          kill: vi.fn(),
          exitCode: 0,
        });
        let stderr = "";
        const spawn = (executable: string) => {
          harness.log.push(`lifecycle:${executable}`);
          const child = Object.assign(new EventEmitter(), {
            pid: 123,
            stderr: Object.assign(new EventEmitter(), { destroy: vi.fn() }),
          });
          queueMicrotask(() => {
            if (options.lifecycleFailure) {
              child.stderr.emit("data", Buffer.from("fixture failure"));
            }
            child.emit("exit", options.lifecycleFailure ? 1 : 0);
            child.emit("close", options.lifecycleFailure ? 1 : 0);
          });
          return child;
        };
        await vm.runInNewContext(command.argv[2]!, {
          Buffer,
          process,
          require: () => ({ spawn }),
          performance: { now: () => 0 },
          setTimeout: vi.fn(),
          clearTimeout: vi.fn(),
          console: {
            error: (message: string) => {
              stderr = message;
            },
          },
        });
        return {
          stdout: "",
          stderr,
          code: process.exitCode,
          signal: null,
          killed: false,
          termination: "exit",
        };
      });
    }
    return { ...tunnel, environmentId: request.environmentId };
  });
  const bindPreparedWorkspace = vi.mocked(harness.environments.bindPreparedWorkspace);
  const ordinaryBind = bindPreparedWorkspace.getMockImplementation()!;
  bindPreparedWorkspace.mockImplementation(async (request) => {
    request.assertCurrent();
    harness.log.push("workspace:bind-prepared");
    return { ...(await ordinaryBind(request)), ...options.boundWorkspace };
  });
  if (!reserve) {
    vi.mocked(harness.environments.createWithRequest).mockResolvedValue(projected);
  }
  const node: NodeWorkerSupervisorNodeProof = {
    nodeId: "prepared-node",
    connId: "prepared-connection",
    pairingIdentity: "prepared-identity",
    pairingGeneration: "prepared-generation",
    clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
    clientMode: GATEWAY_CLIENT_MODES.NODE,
    protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
    workerHost: {
      enabled: true,
      capacity: { total: 1, available: 1 },
      environmentSession: NODE_WORKER_ENVIRONMENT_SESSION_VERSION,
      preparedWorkspace: NODE_WORKER_PREPARED_WORKSPACE_VERSION,
      capturedExecPolicy: true,
      promptContext: 1,
    },
    commands: ["codex.exec-server.stdio.v1"],
  };
  const { nodeRegistry, nodeWorkerSupervisorTransport: transport } = createNodeRegistryRuntime(
    () => new NodeRegistry({ getConfig: getRuntimeConfig }),
  );
  const connectNode = () =>
    nodeRegistry.register(
      {
        connId: node.connId,
        usesSharedGatewayAuth: false,
        socket: {
          readyState: 1,
          bufferedAmount: 0,
          send: vi.fn(),
          close: vi.fn(),
        } as unknown as GatewayWsClient["socket"],
        connect: {
          minProtocol: 1,
          maxProtocol: 1,
          client: { id: node.clientId, version: "test", platform: "linux", mode: node.clientMode },
          device: {
            id: node.nodeId,
            publicKey: "fixture",
            signature: "fixture",
            signedAt: 1,
            nonce: "fixture",
          },
          commands: [...node.commands],
        },
      },
      { pairingIdentity: node.pairingIdentity, pairingGeneration: node.pairingGeneration },
    );
  const setHostingAvailable = (available: boolean, reconnect = false) => {
    if (reconnect) {
      node.connId = "reconnected-without-hosting";
      connectNode();
    }
    updateNodeRunnerInventory({
      registry: nodeRegistry,
      nodeId: node.nodeId,
      connId: node.connId,
      declaration: {
        protocolFeatures: [node.protocolFeature],
        workerHost: available ? node.workerHost : { enabled: false },
      },
    });
  };
  connectNode();
  setHostingAvailable(true);
  onTestFinished(() => {
    nodeRegistry.unregister(node.connId);
  });
  const resolveAvailability = vi.fn(async () => ({
    available: true,
    node: (await transport.listCurrentNodes())[0],
  }));
  bindDeviceWorkerAvailability(harness.environments, resolveAvailability);
  const request = {
    ...REQUEST,
    executionMode,
    setupAuthorized: true,
    devicePlacement: {
      requiredNodeCommands: executionMode === "remote-exec" ? ["codex.exec-server.stdio.v1"] : [],
      consumesWorkerSlot: executionMode === "worker-turn",
    },
  };
  return {
    harness,
    placements,
    store,
    workerService,
    ready,
    intent,
    request,
    transport,
    resolveAvailability,
    setHostingAvailable,
    revokeNode: () => {
      nodeCurrent = false;
    },
  };
}
