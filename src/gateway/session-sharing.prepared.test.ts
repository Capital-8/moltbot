import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { onUserProfilesChanged } from "../state/user-profile-events.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { linkEmail, setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareGatewayRecipientProfile } from "./expected-profile.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { prepareProjectedSessionSharing, prepareSessionSharing } from "./session-sharing.js";
import {
  sharingPolicyClient,
  sharingPolicyTarget,
  rolePolicyConfig,
} from "./session-sharing.test-utils.js";

afterEach(() => vi.restoreAllMocks());

it("reuses interleaved audience keys and copies scope snapshots without iteration", () => {
  const cfg = rolePolicyConfig();
  const clients = ["alice", "bob"].map((user) => sharingPolicyClient({ user }));
  const key = (client: (typeof clients)[number]) =>
    prepareProjectedSessionSharing({ cfg, client, isMember: () => false }).getCacheKey();
  const initial = clients.map(key);
  expect(initial[0]).not.toBe(initial[1]);
  const scopes = clients[0]!.connect.scopes!;
  const iterate = vi.spyOn(scopes, Symbol.iterator);
  const sets = vi.spyOn(globalThis, "Set");
  const reused = clients.map(key);
  const allocations = sets.mock.calls.length;
  sets.mockRestore();
  expect(reused).toEqual(initial);
  expect(allocations).toBe(0);
  // An access publication retires the facts; native array copying avoids iterable expansion.
  setRuntimeConfigSnapshot(cfg);
  expect(clients.map(key)).toEqual(initial);
  expect(iterate).not.toHaveBeenCalled();
  iterate.mockRestore();

  // Scope values, not the array identity, remain live authorization inputs.
  scopes[0] = "operator.admin";
  expect(key(clients[0]!)).not.toBe(initial[0]);
  expect(key(clients[1]!)).toBe(initial[1]);
  scopes[0] = "operator.read";
  expect(key(clients[0]!)).toBe(initial[0]);
  clients[0]!.connect.scopes = [];
  const empty = key(clients[0]!);
  clients[0]!.connect.scopes = undefined;
  expect(key(clients[0]!)).not.toBe(empty);
});

it("refreshes retained sharing facts on profile changes and clears them when identity detaches", async () => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const source = ensureProfileForEmail("source@example.test");
    const target = ensureProfileForEmail("target@example.test");
    using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
    const client = sharingPolicyClient({ user: source.id }) as GatewayWsClient;
    prepareGatewayRecipientProfile(client);
    const stop = onUserProfilesChanged(() => prepareGatewayRecipientProfile(client));
    const cfg = rolePolicyConfig();
    const share = () => prepareProjectedSessionSharing({ cfg, client, isMember: () => false });
    const key = () => share().getCacheKey();
    try {
      const initialKey = key();
      setUserProfileRole(source.id, "view");
      expect(client.preparedSessionProfile?.role).toBe("view");
      expect(key()).toBe(initialKey);
      setUserProfileRole(source.id, "none");
      expect(key()).not.toBe(initialKey);
      expect(share().sessionCap).toBe("none");
      setUserProfileRole(source.id, "view");
      expect(key()).toBe(initialKey);
      setUserProfileRole(target.id, "none");
      linkEmail("source@example.test", target.id);
      expect(client.preparedSessionProfile).toEqual({
        profileId: target.id,
        aliases: new Set([source.id, target.id]),
        role: "none",
        githubLogin: null,
      });
      const mergedKey = key();
      expect(mergedKey).not.toBe(initialKey);
      client.connect.scopes!.push("operator.admin");
      expect(key()).not.toBe(mergedKey);
      client.connect.scopes!.pop();
      expect(key()).toBe(mergedKey);
      // The config owner publishes same-object policy edits before the next read.
      cfg.gateway!.roles!.definitions.none!.sessions.others = "view";
      setRuntimeConfigSnapshot(cfg);
      expect(key()).not.toBe(mergedKey);
      cfg.gateway!.roles!.definitions.none!.sessions.others = "none";
      setRuntimeConfigSnapshot(cfg);
      const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
      const sharing = share();
      expect(sharing.sessionCap).toBe("none");
      expect(sharing.isCreator({ type: "human", source: "profile", id: source.id })).toBe(true);
      expect(sharing.entryFilter?.("agent:main:foreign", { visibility: "shared" })).toBe(false);
      expect(prepare).not.toHaveBeenCalled();
      prepare.mockRestore();
      client.authenticatedUserProfile = undefined;
      prepareGatewayRecipientProfile(client);
      expect(client.preparedSessionProfile).toBeUndefined();
      expect(key()).not.toBe(mergedKey);
    } finally {
      stop();
    }
  });
});

it("uses fresh prepared caller, alias, role, and membership facts without querying SQLite", async () => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const owner = ensureProfileForEmail("owner@example.test");
    const oldOwner = ensureProfileForEmail("old-owner@example.test");
    const target = sharingPolicyTarget({ type: "human", id: oldOwner.id });
    target.entry.visibility = "shared";
    const client = sharingPolicyClient({ user: owner.id });
    const cfg = rolePolicyConfig();
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    const exec = vi.spyOn(DatabaseSync.prototype, "exec");
    for (const [aliases, sessionCap, member, expectedRole, visible, membershipReads] of [
      [new Set([owner.id, oldOwner.id]), undefined, false, "owner", true, 0],
      [new Set([owner.id]), undefined, false, "viewer", true, 1],
      [new Set([owner.id]), undefined, true, "member", true, 1],
      [new Set([owner.id]), "write", false, "member", true, 0],
      [new Set([owner.id]), "none", true, "viewer", false, 0],
      [new Set([owner.id]), "invited", false, "viewer", false, 1],
      [new Set([owner.id]), "invited", true, "member", true, 1],
    ] as const) {
      const isMember = vi.fn(() => member);
      const sharing = prepareSessionSharing({ cfg, client }, { aliases, sessionCap, isMember });
      expect(sharing.roleForTarget(target)).toBe(expectedRole);
      expect(isMember).toHaveBeenCalledTimes(membershipReads);
      if (membershipReads && member) {
        expect(sharing.roleForTarget(target, false)).toBe("viewer");
        expect(isMember).toHaveBeenCalledTimes(membershipReads);
      }
      expect(sharing.canReadTarget(target)).toBe(visible);
      expect(sharing.authorizeTarget(target) === null).toBe(visible);
    }
    client.connect.scopes!.push("operator.admin");
    const adminMembership = vi.fn(() => false);
    const admin = prepareSessionSharing(
      { cfg, client },
      { aliases: new Set([owner.id]), sessionCap: "none", isMember: adminMembership },
    );
    expect(admin.roleForTarget(target)).toBe("admin");
    expect(adminMembership).not.toHaveBeenCalled();
    client.connect.scopes!.pop();
    client.authenticatedUserProfile!.profileId = oldOwner.id;
    const fresh = prepareSessionSharing(
      { cfg, client },
      { aliases: new Set([oldOwner.id]), sessionCap: "none", isMember: () => false },
    );
    expect(fresh.roleForTarget(target)).toBe("owner");
    expect(fresh.entryFilter?.(target.canonicalKey, target.entry)).toBe(true);
    expect(fresh.authorizeTarget(target)).toBeNull();
    expect(prepare).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });
});
