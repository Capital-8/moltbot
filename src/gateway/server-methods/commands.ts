import {
  ErrorCodes,
  errorShape,
  validateCommandsListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { authorizeOperatorScopesForMethod } from "../method-scopes.js";
import { authorizeGatewaySessionCreation, resolveCreatorSandbox } from "../operator-role-policy.js";
import { resolveOperatorSessionCreation } from "../session-creation-provenance.js";
import { resolveAgentIdOrRespondError } from "./agent-id-shared.js";
import { buildCommandsListResult } from "./commands-list-result.js";
import { withSessionDiscoveryAccess } from "./session-discovery-access.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayMethod } from "./validation.js";

class ProjectCommandScopeChangedError extends Error {}

/**
 * A New session draft may preview its selected project's skills only when this
 * client could create that session; otherwise the agent-only catalog stays in effect.
 */
async function resolveProjectSkillRoot(
  params: Pick<
    GatewayRequestHandlerOptions,
    "client" | "context" | "signal" | "hasCurrentClientAuthority"
  > & { cfg: OpenClawConfig; agentId: string; projectId: string },
): Promise<string | undefined> {
  const { cfg, agentId, client } = params;
  const canCreate = () =>
    !authorizeGatewaySessionCreation({ cfg, agentId, client }) &&
    authorizeOperatorScopesForMethod("sessions.create", client?.connect.scopes ?? []).allowed;
  if (!canCreate()) {
    return undefined;
  }
  const profileId = client?.authenticatedUserProfile?.profileId;
  const assertCurrent = () => {
    params.signal?.throwIfAborted();
    if (
      params.hasCurrentClientAuthority?.() === false ||
      params.context.getRuntimeConfig() !== cfg ||
      client?.authenticatedUserProfile?.profileId !== profileId
    ) {
      throw new ProjectCommandScopeChangedError();
    }
  };
  const { resolveSessionProjectSkillRoot } = await import("../session-project-source.js");
  const root = await resolveSessionProjectSkillRoot({
    cfg,
    projectId: params.projectId,
    targetAgentId: agentId,
    resolveSandboxRequired: () =>
      resolveCreatorSandbox(cfg, resolveOperatorSessionCreation(client)) === "required",
    assertCurrent,
  });
  assertCurrent();
  return root && canCreate() ? root : undefined;
}

export const commandsHandlers: GatewayRequestHandlers = {
  "commands.list": defineValidatedGatewayMethod(
    "commands.list",
    validateCommandsListParams,
    async ({ params, respond, context, client, signal, hasCurrentClientAuthority }) => {
      if (params.projectId && params.sessionKey) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "Use projectId only before a session exists; an existing session already owns its project.",
          ),
        );
        return;
      }
      const resolved = resolveAgentIdOrRespondError({
        rawAgentId: params.agentId,
        respond,
        cfg: context.getRuntimeConfig(),
      });
      if (!resolved) {
        return;
      }
      let projectSkillRoot: string | undefined;
      if (params.projectId) {
        try {
          projectSkillRoot = await resolveProjectSkillRoot({
            cfg: resolved.cfg,
            agentId: resolved.agentId,
            projectId: params.projectId,
            client,
            context,
            signal,
            hasCurrentClientAuthority,
          });
        } catch (error) {
          if (!(error instanceof ProjectCommandScopeChangedError)) {
            throw error;
          }
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.UNAVAILABLE,
              "Project access changed while preparing its commands. Retry the request.",
              { retryable: true },
            ),
          );
          return;
        }
      }
      await withSessionDiscoveryAccess(
        {
          client,
          context,
          respond,
          signal,
          hasCurrentClientAuthority,
          sessionKey: params.sessionKey,
          agentId: resolved.agentId,
          changedError: errorShape(
            ErrorCodes.UNAVAILABLE,
            "Session changed while preparing its commands. Retry the request.",
          ),
        },
        (sessionEntry) =>
          buildCommandsListResult({
            cfg: resolved.cfg,
            agentId: resolved.agentId,
            projectSkillRoot,
            provider: params.provider,
            scope: params.scope,
            includeArgs: params.includeArgs,
            sessionKey: params.sessionKey,
            sessionEntry,
          }),
      );
    },
  ),
};
