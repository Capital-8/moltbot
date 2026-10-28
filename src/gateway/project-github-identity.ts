import { readCachedNativeGitHubToken } from "../agents/github-read-identity.js";
import {
  prepareGitHubReadIdentity,
  resolveConfiguredGitHubToolIdentity,
} from "../agents/github-tool-identity.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getRepositoryIntegration } from "../plugins/repository-integration-runtime.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../secrets/runtime-state.js";
import { gitHubPublicApi } from "./github-public-api.js";
import { captureRepositoryClientActor, type RepositoryOperation } from "./repository-dispatch.js";
import { withRepositoryIdentity } from "./repository-integration-identity.js";
import type { GatewayClient } from "./server-methods/client-types.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

/** App reads require a session-owned cleanup path; native project reads remain opt-in. */
export async function prepareGatewayProjectGitHubIdentity(params: {
  agentId: string;
  assertActive: () => void;
  config: OpenClawConfig;
  context: Pick<GatewayRequestContext, "getRuntimeConfig">;
  client?: GatewayClient | null;
  /** Configured owner/repository to admit and issue an App token for. */
  requestedRepository?: string;
  repositoryConnection?: { purpose: "project-add" | "project-search"; requestDigest: string };
  repositoryCredential?: { claim: RepositoryOperation; assertCurrent: () => void };
}) {
  const selected =
    resolveConfiguredGitHubToolIdentity({
      config: params.config,
      agentId: params.agentId,
      scope: "agent",
    }) ??
    resolveConfiguredGitHubToolIdentity({
      config: params.config,
      agentId: params.agentId,
      scope: "system",
    });
  const credential =
    params.repositoryCredential ??
    (params.repositoryConnection
      ? {
          assertCurrent: params.assertActive,
          claim: {
            purpose: params.repositoryConnection.purpose,
            binding: {
              kind: "connection" as const,
              connectionId: params.client?.connId ?? "",
              requestDigest: params.repositoryConnection.requestDigest,
            },
          },
        }
      : undefined);
  const appRead = selected?.kind === "app-installation" && credential !== undefined;
  if (!appRead && params.config.gateway?.projects?.nativeGitHubSearch !== true) {
    return undefined;
  }
  const prepare = (
    env = process.env,
    readNativeCredential?: import("../agents/github-credential-reader.js").GitHubCredentialReader,
    assertActive = params.assertActive,
  ) =>
    prepareGitHubReadIdentity({
      config: params.config,
      sourceConfig: getActiveSecretsRuntimeConfigSnapshot()?.sourceConfig ?? params.config,
      agentId: params.agentId,
      env,
      readNativeCredential,
      allowAppInstallation: appRead,
      requestedRepository: params.requestedRepository,
      getCurrentConfig: params.context.getRuntimeConfig,
      assertActive,
      // A protected identity executable owns token refresh and revalidation.
      refresh: async () => {},
    });
  if (!appRead) {
    return await prepare();
  }
  if (!credential) {
    return await prepare();
  }
  const actor = getRepositoryIntegration(params.config)
    ? captureRepositoryClientActor({
        client: params.client,
        claim: credential.claim,
        assertCurrent: params.assertActive,
      })
    : undefined;
  return await withRepositoryIdentity(
    actor
      ? {
          actorId: actor.actorId,
          authorization: actor.authorization,
          credentialSource: actor.credentialSource,
          profileId: actor.profileId,
          sessionKey:
            credential.claim.binding.kind === "connection"
              ? credential.claim.binding.connectionId
              : credential.claim.binding.sessionKey,
          assertCurrent: actor.assertCurrent,
        }
      : undefined,
    credential,
    prepare,
  );
}

/** Retain the request's issuer config and live transport for project network effects. */
export function captureGatewayProjectGitHubRequest(
  params: {
    context: Pick<GatewayRequestContext, "getRuntimeConfig">;
    signal?: AbortSignal;
    hasCurrentClientAuthority?: () => boolean;
  },
  purpose: "project-add" | "project-search",
) {
  const config = params.context.getRuntimeConfig();
  const assertCurrent = () => {
    params.signal?.throwIfAborted();
    if (params.hasCurrentClientAuthority?.() === false) {
      throw new Error(
        purpose === "project-add"
          ? "Project requester authority changed during preparation"
          : "Project requester authority changed during search",
      );
    }
    if (params.context.getRuntimeConfig() !== config) {
      throw purpose === "project-search"
        ? new gitHubPublicApi.ControlUiGitHubError(502, "GitHub host changed during project search")
        : new Error("Project requester authority changed during preparation");
    }
  };
  return {
    config,
    assertCurrent,
    prepareIdentity: async (request: {
      agentId: string;
      client?: GatewayClient | null;
      requestDigest: string;
    }) => {
      assertCurrent();
      const selected =
        resolveConfiguredGitHubToolIdentity({ config, agentId: request.agentId, scope: "agent" }) ??
        resolveConfiguredGitHubToolIdentity({ config, agentId: request.agentId, scope: "system" });
      if (
        purpose === "project-search" &&
        !getRepositoryIntegration(config) &&
        selected?.kind !== "app-installation"
      ) {
        if (config.gateway?.projects?.nativeGitHubSearch !== true) {
          return undefined;
        }
        // Native search is its own opted-in credential contract; token absence means anonymous search.
        const token = await readCachedNativeGitHubToken(process.env);
        assertCurrent();
        return { token, revoke: undefined, start: undefined };
      }
      return await prepareGatewayProjectGitHubIdentity({
        ...request,
        config,
        context: params.context,
        assertActive: assertCurrent,
        repositoryConnection: { purpose, requestDigest: request.requestDigest },
      });
    },
  };
}
