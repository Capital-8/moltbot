import { normalizeUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { SessionEntryCurrentPreparation } from "./config/sessions/session-entry-current.types.js";
import { withSessionEntriesFromStoreInWorker } from "./config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "./config/types.openclaw.js";
import { runBestEffortCleanup } from "./infra/non-fatal-cleanup.js";
import { closeTrackedBrowserTabsForSessions } from "./plugin-sdk/browser-maintenance.js";
import { parseAgentSessionKey } from "./routing/session-key.js";

function isBrowserCleanupDisabled(cfg: OpenClawConfig | undefined): boolean {
  return cfg?.browser?.enabled === false || cfg?.plugins?.entries?.browser?.enabled === false;
}

export async function cleanupBrowserSessionsForLifecycleEnd(
  params: SessionEntryCurrentPreparation & {
    cfg?: OpenClawConfig;
    sessionKeys: string[];
    sessionTarget?: { agentId: string; sessionKey: string; storePath: string };
    isCurrent?: () => boolean;
    onWarn?: (message: string) => void;
    onError?: (error: unknown) => void;
  },
): Promise<void> {
  const { cfg, onError, sessionTarget, ...cleanupParams } = params;
  if (isBrowserCleanupDisabled(cfg)) {
    return;
  }
  const closeSessions = async (preservedGlobalKey?: string, isCurrent = params.isCurrent) => {
    const sessionKeys = normalizeUniqueStringEntries(
      params.sessionKeys.flatMap((key) => {
        const parsed = parseAgentSessionKey(key);
        const normalized = parsed ? `agent:${parsed.agentId}:${parsed.rest}` : undefined;
        return normalized && normalized !== preservedGlobalKey ? [normalized] : [];
      }),
    );
    if (sessionKeys.length === 0) {
      return;
    }
    await runBestEffortCleanup({
      cleanup: () =>
        closeTrackedBrowserTabsForSessions({ ...cleanupParams, sessionKeys, isCurrent }),
      onError,
    });
  };
  if (
    !sessionTarget ||
    (sessionTarget.sessionKey !== "global" &&
      parseAgentSessionKey(sessionTarget.sessionKey)?.rest !== "global")
  ) {
    return closeSessions();
  }
  const key = `agent:${sessionTarget.agentId}:global`;
  const warnPreserved = () =>
    params.onWarn?.("Preserved shared global browser tabs with ambiguous conversation ownership.");
  try {
    await withSessionEntriesFromStoreInWorker(
      {
        ...sessionTarget,
        sessionKeys: ["global", key],
        projection: "sharing",
        includeAuthorization: true,
      },
      async ({ result: rows, database, assertCurrent }) => {
        const isCurrent = () => {
          assertCurrent();
          return params.isCurrent?.() !== false;
        };
        if (!isCurrent()) {
          return;
        }
        const keys = new Set(
          [...rows.entries, ...(rows.sharing?.placeholders ?? [])].map((row) => row.sessionKey),
        );
        const preserve =
          !rows.sharing ||
          rows.sharing.source.agentId !== database.agentId ||
          rows.sharing.source.path !== database.path ||
          !keys.has(sessionTarget.sessionKey) ||
          (sessionTarget.sessionKey === "global" && database.agentId !== sessionTarget.agentId) ||
          (database.agentId === sessionTarget.agentId && keys.has("global") && keys.has(key));
        if (preserve) {
          warnPreserved();
        }
        await closeSessions(preserve ? key : undefined, isCurrent);
      },
    );
  } catch {
    // Without a current physical source, no new one-chat cleanup claim is justified.
    warnPreserved();
  }
}
