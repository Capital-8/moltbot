import { expect, it, vi } from "vitest";
import {
  sidebarMountedPresenceScope,
  sidebarPresenceActivityViewers,
  sidebarPresenceScope,
} from "./app-sidebar-presence.ts";

type PresenceHost = Parameters<typeof sidebarPresenceScope>[0];

function presenceHost(navigationView: PresenceHost["navigationView"], contextual = false) {
  return {
    navigationView,
    contextualSidebar: contextual
      ? { key: "chat" as const, data: null, loaderPending: false, render: () => null }
      : undefined,
    mountedPresence: vi.fn(() => ({
      sessionKeys: new Set(["agent:main:visible"]),
      activityProfileIds: new Set(["mounted"]),
    })),
    reconciledSidebarZone: vi.fn(() => ({
      entries: [{ type: "person" as const, profileId: "pinned" }],
    })),
    sessionDataContext: { gateway: { snapshot: { selfUser: { id: "self" } } } },
    sessionData: {
      presenceInstanceId: "self-instance",
      presencePayload: {
        presence: [
          { ts: 0, user: { id: "mounted", identity: { type: "profile" as const, id: "mounted" } } },
          { ts: 0, user: { id: "pinned", identity: { type: "profile" as const, id: "pinned" } } },
          { ts: 0, user: { id: "other" } },
        ],
      },
    },
  } satisfies PresenceHost;
}

it.each([
  { view: "sessions", contextual: false, viewers: ["mounted"] },
  { view: "sessions", contextual: true, viewers: [] },
  { view: "pages", contextual: false, viewers: [] },
  { view: "online", contextual: false, viewers: ["mounted", "pinned", "other"] },
] as const)("scopes activity deadlines in $view without projecting inventory", (testCase) => {
  const host = presenceHost(testCase.view, testCase.contextual);
  expect(sidebarPresenceActivityViewers(host).map((viewer) => viewer.id)).toEqual(testCase.viewers);
  const scope = sidebarMountedPresenceScope(host);
  expect([...scope.activityProfileIds]).toEqual(
    testCase.view === "sessions" && !testCase.contextual ? ["mounted"] : [],
  );
  expect(host.reconciledSidebarZone).not.toHaveBeenCalled();
});

it("retains pinned identities and self in the full presence presentation scope", () => {
  const host = presenceHost("sessions");
  const scope = sidebarPresenceScope(host);
  expect([...scope.sessionKeys]).toEqual(["agent:main:visible"]);
  expect([...scope.activityProfileIds]).toEqual(["mounted"]);
  expect([...scope.profileIds]).toEqual(["mounted", "pinned"]);
  expect(scope.selfUser?.id).toBe("self");
  expect(scope.selfInstanceId).toBe("self-instance");
  expect(host.reconciledSidebarZone).toHaveBeenCalledOnce();
});
