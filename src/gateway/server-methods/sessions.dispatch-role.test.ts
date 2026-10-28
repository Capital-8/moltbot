import { afterEach, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  loadSessionEntry,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  getActivePluginRegistry,
  setActivePluginRegistry,
  resetPluginRuntimeStateForTest,
} from "../../plugins/runtime.js";
import {
  prepareUserProfileIdentity,
  readResidentUserProfileIdentity,
} from "../../state/user-profile-list.js";
import {
  ensureCanonicalUserProfileForEmail,
  setCanonicalUserProfileRole,
} from "../../state/user-profile-writes.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { handleGatewayRequest } from "../server-methods.js";
import { resolveGatewaySessionStoreTargetInWorker } from "../session-utils-store-worker.js";
import type { WorkerSessionPlacementRecord } from "../worker-environments/placement-store.js";
import {
  dispatchTestSessionId as sessionId,
  dispatchTestSessionKey as sessionKey,
  getDispatchTestMocks,
  getSessionDispatchHandler,
  makeDispatchTestContext as makeContext,
  makeReclaimedPlacement,
} from "./sessions-dispatch.test-support.js";
import type { GatewayRequestContext } from "./types.js";

const mocks = getDispatchTestMocks();
const originalPluginRegistry = getActivePluginRegistry();
afterEach(() => {
  if (originalPluginRegistry) {
    setActivePluginRegistry(originalPluginRegistry, "dispatch-role-test-restore", "default");
  } else {
    resetPluginRuntimeStateForTest();
  }
});
function activePlacementRecord(): Extract<WorkerSessionPlacementRecord, { state: "active" }> {
  return {
    ...makeReclaimedPlacement(),
    state: "active",
    recoveryError: null,
    terminalReason: null,
    terminalAtMs: null,
  };
}

it("keeps explicit Cloud dispatch inside the write role's live profile grant", async () => {
  setActivePluginRegistry(createEmptyPluginRegistry(), "dispatch-role-test", "default");
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const person = await ensureCanonicalUserProfileForEmail("engineer@example.test");
    await setCanonicalUserProfileRole(person.id, "engineer");
    const profile = await prepareUserProfileIdentity(person.id);
    using _ = { [Symbol.dispose]: () => profile.release() };
    let cfg: OpenClawConfig = {
      session: { store: state.statePath("sessions.json") },
      cloudWorkers: { profiles: { test: { provider: "fake" }, other: { provider: "fake" } } },
      gateway: {
        roles: {
          default: "observer",
          definitions: {
            observer: { sessions: { others: "view" }, agents: [], scopes: ["operator.read"] },
            engineer: {
              sessions: { others: "write" },
              agents: ["main"],
              scopes: ["operator.read", "operator.write"],
              workerProfiles: ["test"],
            },
          },
        },
      },
    };
    const storePath = cfg.session!.store!;
    const createSession = (profileId: string, key = sessionKey, id = sessionId) =>
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: key, storePath },
        {
          sessionId: id,
          updatedAt: 1,
          providerOverride: "anthropic",
          modelOverride: "claude-test",
          createdActor: { type: "human", source: "profile", id: profileId },
          worktree: { id: `worktree-${id}`, branch: "openclaw/cloud-test", repoRoot: "/repo" },
        },
      );
    setRuntimeConfigSnapshot(cfg);
    createSession(person.id);
    mocks.resolveTarget.mockImplementation(resolveGatewaySessionStoreTargetInWorker);
    mocks.findLiveByOwner.mockImplementation((_kind, ownerId) => ({
      id: `worktree-${ownerId === sessionKey ? sessionId : `foreign-${sessionId}`}`,
      ownerKind: "session",
      ownerId,
      path: ownerId === sessionKey ? "/repo/worktree" : "/repo/foreign-worktree",
    }));
    const dispatch = vi
      .fn<NonNullable<GatewayRequestContext["workerPlacementDispatchService"]>["dispatch"]>()
      .mockResolvedValue(activePlacementRecord());
    const context = makeContext({
      getRuntimeConfig: () => cfg,
      workerPlacementDispatchService: { dispatch },
      workerSessionPlacementService: { getMany: () => new Map() },
    });
    const request = async (
      scope: "operator.read" | "operator.write",
      profileId: string,
      key = sessionKey,
    ) => {
      const respond = vi.fn();
      await handleGatewayRequest({
        req: {
          type: "req",
          id: `dispatch-${scope}-${profileId}`,
          method: "sessions.dispatch",
          params: { key, profileId },
        },
        respond,
        client: {
          connId: `conn-${scope}-${profileId}`,
          authenticatedUserProfile: {
            profileId: person.id,
            displayName: null,
            hasAvatar: false,
            updatedAt: person.updatedAt,
          },
          preparedSessionProfile: readResidentUserProfileIdentity(person.id),
          connect: {
            role: "operator",
            scopes: [scope],
            client: { id: "test", version: "1", platform: "test", mode: "test" },
            minProtocol: 1,
            maxProtocol: 1,
          },
        },
        isWebchatConnect: () => false,
        context,
        extraHandlers: { "sessions.dispatch": getSessionDispatchHandler() },
      });
      return respond;
    };
    for (const [scope, workerProfile] of [
      ["operator.read", "test"],
      ["operator.write", "other"],
    ] as const) {
      const denied = await request(scope, workerProfile);
      expect(denied).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: ErrorCodes.FORBIDDEN }),
      );
      expect(dispatch).not.toHaveBeenCalled();
    }
    const allowed = await request("operator.write", "test");
    expect(allowed).toHaveBeenCalledWith(true, expect.objectContaining({ ok: true }), undefined);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "test", runSetupScript: false }),
      expect.any(Function),
      expect.any(Function),
      undefined,
    );

    const other = await ensureCanonicalUserProfileForEmail("other@example.test");
    const foreignKey = "agent:main:foreign-cloud-session";
    createSession(other.id, foreignKey, `foreign-${sessionId}`);
    expect(
      loadSessionEntry({ agentId: "main", sessionKey: foreignKey, storePath })?.createdActor,
    ).toEqual({ type: "human", source: "profile", id: other.id });
    const foreign = await request("operator.write", "test", foreignKey);
    expect(foreign).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: ErrorCodes.FORBIDDEN }),
    );
    expect(dispatch).toHaveBeenCalledOnce();

    const effect = vi.fn();
    dispatch.mockImplementationOnce(async (_target, _onTransition, authorize) => {
      cfg = {
        ...cfg,
        gateway: {
          ...cfg.gateway,
          roles: {
            ...cfg.gateway!.roles!,
            definitions: {
              ...cfg.gateway!.roles!.definitions,
              engineer: { ...cfg.gateway!.roles!.definitions.engineer!, workerProfiles: [] },
            },
          },
        },
      };
      setRuntimeConfigSnapshot(cfg);
      authorize?.();
      effect();
      return activePlacementRecord();
    });
    const revoked = await request("operator.write", "test");
    expect(revoked).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: ErrorCodes.FORBIDDEN }),
    );
    expect(effect).not.toHaveBeenCalled();
  });
});
