// Tests browser lifecycle cleanup after CLI and runtime shutdown paths.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { replaceSessionEntry } from "./config/sessions/session-accessor.sqlite-entry.js";
import type { OpenClawConfig } from "./config/types.openclaw.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "./state/openclaw-agent-db.js";
import { withOpenClawTestState } from "./test-utils/openclaw-test-state.js";

const closeTrackedBrowserTabsForSessions = vi.hoisted(() =>
  vi.fn<typeof import("./plugin-sdk/browser-maintenance.js").closeTrackedBrowserTabsForSessions>(
    async () => 0,
  ),
);

vi.mock("./plugin-sdk/browser-maintenance.js", () => ({
  closeTrackedBrowserTabsForSessions,
}));

const { cleanupBrowserSessionsForLifecycleEnd } = await import("./browser-lifecycle-cleanup.js");

describe("cleanupBrowserSessionsForLifecycleEnd", () => {
  beforeEach(() => {
    closeTrackedBrowserTabsForSessions.mockReset().mockResolvedValue(0);
  });

  it("normalizes session keys before closing browser sessions", async () => {
    const onWarn = vi.fn();
    const isCurrent = () => true;
    const prepareCurrent = async () => true;

    await expect(
      cleanupBrowserSessionsForLifecycleEnd({
        sessionKeys: [
          "",
          "global",
          "  agent:alpha:global  ",
          "agent:alpha:global",
          "agent:beta:global",
        ],
        isCurrent,
        prepareCurrent,
        onWarn,
      }),
    ).resolves.toBeUndefined();

    expect(closeTrackedBrowserTabsForSessions).toHaveBeenCalledWith({
      sessionKeys: ["agent:alpha:global", "agent:beta:global"],
      isCurrent,
      prepareCurrent,
      onWarn,
    });
  });

  it.each([
    ["single row", "main", false, false, true],
    ["same-owner pair", "main", true, false, false],
    ["different physical owner", "ops", true, false, true],
    ["source owner closes before tab cleanup", "main", false, true, false],
  ] as const)(
    "keeps browser cleanup on its current owner: %s",
    async (_name, owner, pair, withdraw, closes) => {
      await withOpenClawTestState({ prefix: "browser-cleanup-owner-" }, async (state) => {
        const storePath = state.path("shared.sqlite");
        const key = "agent:main:global";
        openOpenClawAgentDatabase({ agentId: owner, path: storePath, env: state.env });
        await replaceSessionEntry(
          { agentId: owner, sessionKey: "global", storePath },
          { sessionId: "raw", updatedAt: 1 },
        );
        if (pair) {
          await replaceSessionEntry(
            { agentId: "main", sessionKey: key, storePath },
            { sessionId: "literal", updatedAt: 1 },
          );
        }
        const closed: Array<string | undefined> = [];
        let closing: Promise<boolean> | undefined;
        closeTrackedBrowserTabsForSessions.mockImplementationOnce(async (params) => {
          if (withdraw) {
            // Close revokes immediately; join only after cleanup releases its retained reader.
            closing = closeOpenClawAgentDatabaseByPathAsync(storePath, owner);
            void closing.catch(() => {});
          }
          if (params.isCurrent?.() !== false) {
            closed.push(...params.sessionKeys);
          }
          return closed.length;
        });
        await cleanupBrowserSessionsForLifecycleEnd({
          sessionTarget: { agentId: "main", sessionKey: pair ? key : "global", storePath },
          sessionKeys: [key],
        });
        await closing;
        expect(closed).toEqual(closes ? [key] : []);
      });
    },
  );

  it("skips cleanup when root browser support is disabled", async () => {
    await expect(
      cleanupBrowserSessionsForLifecycleEnd({
        cfg: { browser: { enabled: false } } as OpenClawConfig,
        sessionKeys: ["agent:alpha:global"],
      }),
    ).resolves.toBeUndefined();

    expect(closeTrackedBrowserTabsForSessions).not.toHaveBeenCalled();
  });

  it("skips cleanup when the browser plugin entry is disabled", async () => {
    await expect(
      cleanupBrowserSessionsForLifecycleEnd({
        cfg: { plugins: { entries: { browser: { enabled: false } } } } as OpenClawConfig,
        sessionKeys: ["agent:alpha:global"],
      }),
    ).resolves.toBeUndefined();

    expect(closeTrackedBrowserTabsForSessions).not.toHaveBeenCalled();
  });

  it("swallows browser cleanup failures", async () => {
    const onError = vi.fn();
    const error = new Error("cleanup failed");
    closeTrackedBrowserTabsForSessions.mockRejectedValueOnce(error);

    await expect(
      cleanupBrowserSessionsForLifecycleEnd({
        sessionKeys: ["agent:alpha:global"],
        onError,
      }),
    ).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledWith(error);
  });
});
