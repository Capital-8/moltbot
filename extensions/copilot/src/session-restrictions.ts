import type { SessionConfig } from "@github/copilot-sdk";

const COPILOT_ISOLATED_EXCLUDED_TOOLS = ["builtin:*", "mcp:*", "custom:*"] as const;

/** Disable every ambient SDK capability for a prompt-only or settled final turn. */
export function createCopilotIsolatedSessionRestrictions(): Partial<SessionConfig> {
  return {
    availableTools: [],
    coauthorEnabled: false,
    customAgents: [],
    customAgentsLocalOnly: true,
    embeddingCacheStorage: "in-memory",
    enableConfigDiscovery: false,
    enableFileHooks: false,
    enableHostGitOperations: false,
    enableOnDemandInstructionDiscovery: false,
    enableSessionStore: false,
    enableSkills: false,
    excludedTools: [...COPILOT_ISOLATED_EXCLUDED_TOOLS],
    includeSubAgentStreamingEvents: false,
    infiniteSessions: { enabled: false },
    instructionDirectories: [],
    manageScheduleEnabled: false,
    mcpOAuthTokenStorage: "in-memory",
    mcpServers: {},
    memory: { enabled: false },
    pluginDirectories: [],
    requestCanvasRenderer: false,
    requestExtensions: false,
    skillDirectories: [],
    skipCustomInstructions: true,
    skipEmbeddingRetrieval: true,
    tools: [],
  };
}

export type CopilotRemoteDenySession = {
  rpc?: { remote?: { disable?: () => Promise<unknown> } };
};

/**
 * Deny Mission Control export and remote steering before an isolated turn sends anything.
 *
 * SDK 1.0.26 removed the create/resume `remoteSession` option; the session's
 * `remote.disable` RPC is the remaining explicit runtime deny. Failure rejects
 * the turn instead of sending its prompt with remote state unconfirmed.
 */
export async function denyCopilotIsolatedSessionRemote(
  session: CopilotRemoteDenySession,
): Promise<void> {
  const remote = session.rpc?.remote;
  if (!remote?.disable) {
    throw new Error("[copilot] isolated session cannot disable remote export and steering");
  }
  await remote.disable();
}
