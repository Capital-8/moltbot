import type { CommandsListResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { peekChatMetadata } from "./chat-metadata-store.ts";
import {
  buildFallbackSlashCommands,
  buildSlashCommandsFromEntries,
  replaceSlashCommands,
  type SlashCommandDef,
} from "./commands.ts";

let refreshSeq = 0;
const REMOTE_SLASH_COMMAND_CACHE_TTL_MS = 60_000;

type RemoteSlashCommandCacheEntry = {
  commands?: SlashCommandDef[];
  expiresAt: number;
  inFlight?: Promise<SlashCommandDef[]>;
};

const remoteSlashCommandCache = new WeakMap<
  GatewayBrowserClient,
  Map<string, RemoteSlashCommandCacheEntry>
>();

type RemoteSlashCommandScope = {
  agentId?: string;
  sessionKey?: string;
  /** Registered project selected by a New session draft; never combined with sessionKey. */
  projectId?: string;
};

function remoteSlashCommandCacheKey(scope: RemoteSlashCommandScope): string {
  return JSON.stringify([scope.agentId ?? null, scope.sessionKey ?? null, scope.projectId ?? null]);
}

function loadRemoteSlashCommands(
  client: GatewayBrowserClient,
  scope: RemoteSlashCommandScope,
): Promise<SlashCommandDef[]> {
  const { agentId, sessionKey, projectId } = scope;
  // Chat metadata is agent/session scoped; a selected project needs its own catalog.
  const metadata = projectId ? undefined : peekChatMetadata(client, { agentId, sessionKey });
  // Store-held metadata carries app-level invalidation on config changes and logical reconnects,
  // so no TTL applies here. The cache below owns only commands.list-derived entries.
  if (metadata) {
    return Promise.resolve(buildSlashCommandsFromEntries(metadata.commands));
  }
  let cache = remoteSlashCommandCache.get(client);
  if (!cache) {
    cache = new Map();
    remoteSlashCommandCache.set(client, cache);
  }
  const key = remoteSlashCommandCacheKey(scope);
  const cached = cache.get(key);
  const now = Date.now();
  if (cached?.commands && cached.expiresAt > now) {
    return Promise.resolve(cached.commands);
  }
  if (cached?.inFlight) {
    return cached.inFlight;
  }
  const entry: RemoteSlashCommandCacheEntry = {
    commands: cached?.commands,
    expiresAt: cached?.expiresAt ?? 0,
  };
  const inFlight = (async () => {
    try {
      const result = await client.request<CommandsListResult>("commands.list", {
        ...(agentId ? { agentId } : {}),
        ...(sessionKey ? { sessionKey } : {}),
        ...(projectId ? { projectId } : {}),
        includeArgs: true,
        scope: "text",
      });
      return buildSlashCommandsFromEntries(result.commands);
    } catch {
      return undefined;
    }
  })()
    .then((commands) => {
      if (commands) {
        entry.commands = commands;
        entry.expiresAt = Date.now() + REMOTE_SLASH_COMMAND_CACHE_TTL_MS;
      }
      return commands ?? cached?.commands ?? buildFallbackSlashCommands();
    })
    .finally(() => {
      delete entry.inFlight;
    });
  entry.inFlight = inFlight;
  cache.set(key, entry);
  return inFlight;
}

export function invalidateSessionSlashCommands(
  client: GatewayBrowserClient,
  scope: { agentId: string; sessionKey: string },
): void {
  refreshSeq += 1;
  remoteSlashCommandCache.get(client)?.delete(remoteSlashCommandCacheKey(scope));
}

export function applyRemoteSlashCommandsResult(
  result: CommandsListResult | null | undefined,
): boolean {
  if (!result) {
    return false;
  }
  const commands = buildSlashCommandsFromEntries(result.commands);
  refreshSeq += 1;
  replaceSlashCommands(commands);
  return true;
}

export async function refreshSlashCommands(params: {
  client: GatewayBrowserClient | null;
  agentId?: string | null;
  sessionKey?: string;
  projectId?: string;
  shouldApply?: () => boolean;
}): Promise<void> {
  const seq = ++refreshSeq;
  const agentId = params.agentId?.trim() || undefined;
  const projectId = params.sessionKey ? undefined : params.projectId?.trim() || undefined;
  const commands = params.client
    ? await loadRemoteSlashCommands(params.client, {
        agentId,
        sessionKey: params.sessionKey,
        projectId,
      })
    : undefined;
  if (seq !== refreshSeq || params.shouldApply?.() === false) {
    return;
  }
  replaceSlashCommands(commands ?? buildFallbackSlashCommands());
}
