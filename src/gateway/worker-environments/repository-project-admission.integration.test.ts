import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RepositoryIntegration } from "../../plugins/repository-integration.types.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  repositoryDispatchCredentialReader,
  repositoryProjectCredentialReader,
} from "../repository-dispatch.js";
import type { GatewayClient } from "../server-methods/types.js";
import { createWorkerEnvironmentAccess } from "./environment-access.js";
import { PREPARATION_KEY, usePreparedPoolFixture } from "./prepared-pool.test-support.js";
import { createWorkerProjectPreparation } from "./project-preparation.js";
import { prepareRepositoryWorkerProjectSource } from "./repository-project-admission.js";
const policy = vi.hoisted(() => ({ current: undefined as RepositoryIntegration | undefined }));
vi.mock("../../plugins/repository-integration-runtime.js", () => ({
  getRepositoryIntegration: () => policy.current,
}));
const directories = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  policy.current = undefined;
  closeOpenClawStateDatabaseForTest();
  clearRuntimeConfigSnapshot();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("admits public source without a native CLI and fences later configured identity state", async () => {
  const root = directories.make("repository-no-native-cli-");
  const nativeConfig = path.join(root, "native");
  const emptyPath = path.join(root, "bin");
  await fs.mkdir(nativeConfig);
  await fs.mkdir(emptyPath);
  vi.stubEnv("PATH", emptyPath);
  vi.stubEnv("GH_CONFIG_DIR", nativeConfig);
  vi.stubEnv("GH_TOKEN", undefined);
  vi.stubEnv("GITHUB_TOKEN", undefined);
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
  const commit = "a".repeat(40);
  const tree = "b".repeat(40);
  const repositoryUrl = "https://github.com/acme/public-project.git";
  const config = { agents: { entries: { "public-source": { workspace: root } } } };
  // Only HTTP is substituted: identity selection, missing CLI execution,
  // configuration absence and durable agent ownership use their real owners.
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init);
    expect(request.method).toBe("GET");
    expect(request.headers.has("authorization")).toBe(false);
    const pathname = new URL(request.url).pathname;
    let body: unknown;
    if (pathname === "/repos/acme/public-project") {
      body = {
        node_id: "R_public_fixture",
        clone_url: repositoryUrl,
        private: false,
        default_branch: "main",
      };
    } else if (pathname.startsWith("/repos/acme/public-project/commits/")) {
      body = { sha: commit, commit: { tree: { sha: tree } } };
    } else if (pathname === `/repos/acme/public-project/git/commits/${commit}`) {
      body = { sha: commit, tree: { sha: tree } };
    } else if (pathname === `/repos/acme/public-project/git/trees/${tree}`) {
      body = { sha: tree, truncated: false, tree: [] };
    } else {
      throw new Error("Unexpected public metadata request");
    }
    return new Response(JSON.stringify(body));
  });
  vi.stubGlobal("fetch", fetchMock);

  const admitted = await prepareRepositoryWorkerProjectSource({
    repository: { agentId: "public-source", url: repositoryUrl },
    namespace: "public-source-test",
    getConfig: () => config,
    assertCurrent: () => {},
  });

  expect(admitted.project.baseCommit).toBe(commit);
  expect(admitted.project.source.owner.identity).toEqual({ source: "anonymous" });
  await expect(admitted.revalidate()).resolves.toBeUndefined();
  const reopened = await prepareRepositoryWorkerProjectSource({
    expected: admitted.project,
    namespace: "public-source-test",
    getConfig: () => config,
    assertCurrent: () => {},
  });
  expect(reopened.project).toEqual(admitted.project);
  expect(admitted).not.toHaveProperty("readGitToken");
  expect(fetchMock).toHaveBeenCalled();
  await fs.writeFile(path.join(nativeConfig, "config.yml"), "{}\n");
  fetchMock.mockClear();
  await expect(admitted.revalidate()).rejects.toThrow("credential is unavailable");
  expect(fetchMock).not.toHaveBeenCalled();
});

// Resident profile facts replace storage only; App admission, proofs, issuance and cleanup stay real.
vi.mock("../../state/user-profile-list.js", async (original) => ({
  ...(await original<typeof import("../../state/user-profile-list.js")>()),
  captureResidentUserProfileAccess: () => ({
    readCurrentFacts: () => ({ profileId: "person-1", emails: ["github:engineering.ghe.com:42"] }),
  }),
}));
const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  type: "pkcs8",
  format: "pem",
});
const host = "engineering.ghe.com";
const apiBaseUrl = `https://api.${host}`;
const permissions = { contents: "read" as const, metadata: "read" as const };
const commit = "a".repeat(40);
const tree = "b".repeat(40);

const fixture = usePreparedPoolFixture();
const REQUEST = { agentId: "main", sessionId: "session-1", sessionKey: "agent:main:session-1" };
it.each(
  (
    [
      "configured",
      "inherited",
      "revoked",
      "missing-reader",
      "outside-selection",
      "broker-denied",
      "cleanup-settlement",
    ] as const
  ).flatMap((selection) =>
    (selection === "configured"
      ? (["dispatch", "prepare", "bind"] as const)
      : (["dispatch", "prepare"] as const)
    ).map((mode) => ({ selection, mode })),
  ),
)(
  "admits only the selected App with cleanup custody ($selection/$mode)",
  async ({ selection, mode }) => {
    const root = directories.make("repository-app-admission-");
    const config: OpenClawConfig = {};

    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    config.agents = { entries: { main: {} } };
    vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", "synthetic-broker-password");
    config.gateway = { github: { host, apiBaseUrl } };
    config.tools = {
      github: {
        kind: "app-installation",
        profileId: "ghp_00000000000000000000000000000001",
        app: {
          appId: 101,
          installationId: 202,
          accountId: 303,
          repositories: [
            { id: 405, fullName: "example/other" },
            ...(selection === "outside-selection"
              ? []
              : [{ id: 404, fullName: "example/project" }]),
          ],
          permissions,
          privateKey,
          keyVersion: "synthetic-v1",
        },
      },
    };
    setRuntimeConfigSnapshot(config);
    const caller: GatewayClient = {
      connId: "human-connection",
      authenticatedGitHubAccountId: 42,
      authenticatedRepositoryCredentialSource: Object.freeze({
        id: `browser:${"b".repeat(64)}`,
        expiresAtMs: Date.now() + 300_000,
      }),
      authenticatedUserId: `github:${host}:42`,
      authenticatedUserProfile: {
        profileId: "person-1",
        displayName: null,
        hasAvatar: false,
        updatedAt: 1,
      },
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        client: { id: "cli", version: "test", platform: "test", mode: "cli" },
        role: "operator",
        scopes: ["operator.write"],
      },
      internal: { authenticatedOperator: true },
    };
    const requestDigest = sha256Hex("retained-fixture-target");
    const identity =
      mode === "bind"
        ? {
            agentId: "main",
            sessionId: "session:prepared-bind",
            sessionKey: "agent:main:session:prepared-bind",
          }
        : REQUEST;
    const readerParams = {
      ...identity,
      client: caller,
      requestDigest,
      assertCurrent: () => {},
    };
    policy.current = {
      version: 1,
      preparedCapacity: "image",
      resolveConnectionIdentity: () => undefined,
      async withIdentity(context, run) {
        context.assertCurrent();
        expect(context.actor).toMatchObject({
          actorId: 42,
          profileId: "person-1",
          credentialSource: caller.authenticatedRepositoryCredentialSource,
        });
        expect(context.operation).toMatchObject({
          purpose: mode === "prepare" ? "project-add" : "session-dispatch-project",
        });
        return run({
          env: context.env,
          assertCurrent: context.assertCurrent,
          readNativeCredential: async (_env, admission) => {
            context.assertCurrent();
            expect(admission).toMatchObject({ kind: "repository-admission", host });
            if (selection === "broker-denied") {
              throw new Error("Integration admission denied");
            }
            if (selection === "revoked") {
              caller.invalidated = true;
            }
            context.assertCurrent();
            return undefined;
          },
        });
      },
    };
    const reader =
      mode === "prepare"
        ? repositoryProjectCredentialReader(readerParams)
        : repositoryDispatchCredentialReader(readerParams);
    if (!reader) {
      throw new Error("Expected Factory reader");
    }
    const readNativeCredential = vi.fn(reader);
    const cleanupEntered = createDeferred();
    const releaseCleanup = createDeferred();
    let minted = 0;
    let revoked = 0;
    const fetchMetadata = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      let result: unknown;
      expect(url.origin).toBe(apiBaseUrl);
      if (url.pathname === "/app") {
        result = { id: 101, slug: "factory", permissions };
      } else if (url.pathname === "/app/installations/202") {
        result = { id: 202, app_id: 101, account: { id: 303 }, suspended_at: null, permissions };
      } else if (url.pathname === "/app/installations/202/access_tokens") {
        expect(await request.json()).toEqual({ repository_ids: [404], permissions });
        minted++;
        result = {
          token: "synthetic-app-token",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          permissions,
        };
      } else if (url.pathname === "/installation/token" && request.method === "DELETE") {
        expect(request.headers.get("authorization")).toBe("Bearer synthetic-app-token");
        cleanupEntered.resolve();
        if (selection === "cleanup-settlement") {
          await releaseCleanup.promise;
        }
        revoked++;
        return new Response(null, { status: 204 });
      } else if (url.pathname === "/users/factory%5Bbot%5D") {
        result = { id: 9001, login: "factory[bot]", type: "Bot", avatar_url: null };
      } else if (url.pathname === "/installation/repositories") {
        result = { total_count: 1, repositories: [{ id: 404, full_name: "example/project" }] };
      } else if (url.pathname === "/graphql") {
        result = {
          data: {
            node: {
              __typename: "Repository",
              node_id: "R_retained_fixture",
              clone_url: `https://${host}/example/project.git`,
              private: true,
              object: { __typename: "Commit", sha: commit, tree: { sha: tree } },
            },
          },
        };
      } else if (url.pathname === "/repos/example/project") {
        result = {
          node_id: "R_retained_fixture",
          clone_url: `https://${host}/example/project.git`,
          private: true,
        };
      } else if (url.pathname === `/repos/example/project/git/commits/${commit}`) {
        result = { sha: commit, tree: { sha: tree } };
      } else if (url.pathname === `/repos/example/project/git/trees/${tree}`) {
        result = { sha: tree, truncated: false, tree: [] };
      } else {
        throw new Error(`Unexpected fixture metadata request: ${url.pathname}`);
      }
      if (url.pathname.startsWith("/repos/") || url.pathname === "/graphql") {
        expect(url.origin).toBe(apiBaseUrl);
        expect(request.headers.get("authorization")).toBe("Bearer synthetic-app-token");
      }
      if (
        abortRevalidation &&
        (url.pathname.startsWith("/repos/") || url.pathname === "/graphql")
      ) {
        abortRevalidation.abort(new DOMException("Transient revalidation canceled", "AbortError"));
        abortRevalidation = undefined;
      }
      return new Response(JSON.stringify(result));
    });
    vi.stubGlobal("fetch", fetchMetadata);

    let admissionCurrent = true;
    let abortRevalidation: AbortController | undefined;
    const cleanups: Array<() => Promise<void>> = [];
    const prepare = (
      expected?: Awaited<ReturnType<typeof prepareRepositoryWorkerProjectSource>>["project"],
    ) =>
      prepareRepositoryWorkerProjectSource({
        ...(expected
          ? { expected }
          : {
              repository: {
                agentId: "main",
                url: `https://${host}/example/project.git`,
                baseCommit: commit,
              },
            }),
        namespace: "app-admission-fixture",
        getConfig: () => config,
        assertCurrent: () => {
          if (!admissionCurrent) {
            throw new Error("Original admission source closed");
          }
        },
        ...(selection === "missing-reader" ? {} : { readNativeCredential }),
        retainCredentialCleanup: (revoke) => cleanups.push(revoke),
      });
    try {
      if (["revoked", "missing-reader", "outside-selection", "broker-denied"].includes(selection)) {
        await expect(prepare()).rejects.toThrow(/GitHub/);
        expect(minted).toBe(0);
        expect(cleanups).toHaveLength(0);
        if (selection === "missing-reader" || selection === "outside-selection") {
          expect(readNativeCredential).not.toHaveBeenCalled();
        }
      } else {
        const admitted = await prepare();
        expect(admitted.project.baseCommit).toBe(commit);
        if (mode === "bind") {
          const record = await fixture.attach(
            await fixture.ready(
              await fixture.seed("prepared-bind", {
                repository: admitted.project,
              }),
            ),
          );
          const bind = vi.fn(async (request: { assertCurrent: () => void }) => {
            request.assertCurrent();
            expect(request).not.toHaveProperty("readNativeCredential");
            expect(request).not.toHaveProperty("retainCredentialCleanup");
            return {
              gatewayNamespace: "app-admission-fixture",
              environmentId: record.environmentId,
              preparationKey: PREPARATION_KEY,
              cacheKey: "9".repeat(64),
              workspaceDir: "/worker/prepared/workspace",
              homeDir: "/worker/prepared/home",
              sourceManifestRef: `sha256:${"a".repeat(64)}`,
              preparedManifestRef: `sha256:${"b".repeat(64)}`,
            };
          });
          const access = createWorkerEnvironmentAccess({
            store: fixture.store,
            getCleanupError: () => undefined,
            readStartStatus: () => undefined,
            getConfig: () => config,
            projectNamespace: "app-admission-fixture",
            bindPreparedWorkspace: bind,
            prepareCurrentBundle: async () => {
              throw new Error("No tunnel during binding");
            },
            now: () => fixture.nowMs,
            identityResolverFor: () => {
              throw new Error("No SSH during binding");
            },
            isStopping: () => false,
            providerFor: () => fixture.provider,
            resolveProvider: () => fixture.provider,
            withLock: async (_id, run) => await run(),
          });
          const bound = await access.bindPreparedWorkspace({
            environmentId: record.environmentId,
            ownerEpoch: record.ownerEpoch,
            sessionId: identity.sessionId,
            sessionKey: identity.sessionKey,
            preparationKey: PREPARATION_KEY,
            cacheKey: "9".repeat(64),
            assertCurrent: admitted.assertCurrent,
            readNativeCredential,
            retainCredentialCleanup: (revoke) => cleanups.push(revoke),
          });
          expect(bound.workspaceDir).toBe("/worker/prepared/workspace");
          expect(bind).toHaveBeenCalledOnce();
          // Initial source admission, binding admission, and post-bind revalidation
          // each retain their own App token under the original dispatch cleanup.
          expect(minted).toBe(3);
          expect(cleanups).toHaveLength(3);
          admissionCurrent = false;
          expect(bound.assertCurrent).toThrow("Original admission source closed");
          admissionCurrent = true;
        }

        if (selection === "inherited") {
          expect((await prepare(admitted.project)).project).toEqual(admitted.project);
        }
        expect(readNativeCredential.mock.calls[0]?.[1]).toMatchObject({
          kind: "repository-admission",
          host,
          selection: {
            kind: "app-installation",
            app: { repositories: [{ id: 404, fullName: "example/project" }] },
          },
        });
        expect(minted).toBe(mode === "bind" ? 3 : selection === "inherited" ? 2 : 1);
        expect(cleanups).toHaveLength(minted);
        if (selection === "configured") {
          const projectOperation = createWorkerProjectPreparation({
            project: admitted.project,
            namespace: "app-admission-fixture",
            requireCurrent: admitted.assertCurrent,
          });
          // Git-pack revalidation uses this operation's signal; node finish later
          // consumes the original repository admission after the operation closes.
          try {
            await admitted.revalidate(projectOperation.project.signal);
          } finally {
            projectOperation.close();
          }
          expect(projectOperation.project.assertCurrent).toThrow(
            "Project preparation operation is closed",
          );
          expect(admitted.assertCurrent).not.toThrow();
          const transient = new AbortController();
          abortRevalidation = transient;
          await expect(admitted.revalidate(transient.signal)).rejects.toThrow(
            "Transient revalidation canceled",
          );
          expect(admitted.assertCurrent).not.toThrow();
          admissionCurrent = false;
          expect(admitted.assertCurrent).toThrow("Original admission source closed");
          expect(cleanups).toHaveLength(minted);
        }
        if (selection === "cleanup-settlement") {
          let settled = false;
          const cleanup = cleanups.shift()!().finally(() => {
            settled = true;
          });
          const entered = await Promise.race([
            cleanupEntered.promise.then(() => true),
            cleanup.then(
              () => false,
              () => false,
            ),
          ]);
          expect(entered).toBe(true);
          expect(settled).toBe(false);
          expect(revoked).toBe(0);
          releaseCleanup.resolve();
          await cleanup;
          expect(settled).toBe(true);
        }
      }
    } finally {
      releaseCleanup.resolve();
      for (const cleanup of cleanups) {
        await cleanup();
      }
    }
    expect(revoked).toBe(minted);
  },
);
