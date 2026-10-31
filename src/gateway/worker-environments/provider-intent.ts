import fsp from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  matchesAgentLifecycleBinding,
  matchesAgentLifecycleBindingAsync,
} from "../../agents/agent-lifecycle-registry.js";
import type { GitHubCredentialReader } from "../../agents/github-credential-reader.js";
import { resolveConfiguredGitHubToolIdentity } from "../../agents/github-tool-identity.js";
import { resolveGitRepositoryPaths } from "../../agents/worktrees/git.js";
import type { CloudWorkerProfileConfig } from "../../config/types.cloud-workers.js";
import { normalizeCapabilityProviderId } from "../../plugins/provider-registry-shared.js";
import type { WorkerExecutionMode, WorkerProfile, WorkerProvider } from "../../plugins/types.js";
import type { RetainedWorkspaceAuthority } from "../../state/retained-workspace-authority.js";
import { workerEnvironmentServiceError as serviceError } from "./environment-errors.js";
import { assertEnvironmentRecipeSecretsMapped } from "./environment-recipe.js";
import {
  createWorkerPreparationIdentity,
  type WorkerProviderPreparedIntent,
} from "./preparation-identity.js";
import {
  readWorkerProjectPreparation,
  readWorkerPreparation,
  type WorkerProjectPreparationIdentity,
  workerPreparationSourceKey,
} from "./preparation-identity.schema.js";
import {
  readWorkerProjectEnvironmentRecipe,
  readWorkerProjectSnapshot,
  workerProjectReplayIdentity,
} from "./project-preparation.js";
import type { WorkerProviderIntentOptions } from "./provider-lifecycle.types.js";
import { prepareRepositoryWorkerProjectSource } from "./repository-project-admission.js";
import type { RepositoryWorkerProjectSnapshot } from "./repository-project-source.schema.js";
import { createWorkerSessionDiskRetention } from "./retained-lease-lifecycle.js";
import { resumeOriginalRetainedWorkspaceOwner } from "./retained-workspace.js";
import { deriveEnvironmentIntent, workerAllocationProfileSnapshot } from "./service-contract.js";
import {
  requireInheritedWorkerProfileAuthorization,
  requireWorkerProfile,
} from "./service-validation.js";
import type { WorkerEnvironmentRecord } from "./store.js";
import { prepareWorkerProjectSnapshot, workerLocalProjectKey } from "./workspace-git-base.js";

export function configuredWorkerProfileSnapshot(profile: CloudWorkerProfileConfig): WorkerProfile {
  return {
    install: profile.install ?? "bundle",
    settings: requireWorkerProfile(profile.settings ?? {}),
    ...(profile.retention ? { retention: profile.retention } : {}),
    ...(profile.runSetupScript === undefined ? {} : { runSetupScript: profile.runSetupScript }),
  };
}

export type WorkerProviderIntentPreparationOptions = {
  retentionOwner?: { sessionId: string; sessionKey: string; agentId: string };
  retainedWorkspaceAuthority?: RetainedWorkspaceAuthority;
  inherited?: { providerId: string; profileSnapshot: WorkerProfile };
  machineClass?: string;
  os?: string;
  executionMode?: WorkerExecutionMode;
  projectPath?: string;
  projectCommit?: string;
  /** Refill only: the retained source already admitted an empty committed workspace. */
  emptyWorkspace?: true;
  /** Dedicated runtime capacity admitted without repository contents or read authority. */
  imageReserve?: true;
  repository?: { agentId: string; url: string; ref?: string; baseCommit?: string };
  projectRepository?: RepositoryWorkerProjectSnapshot;
  runSetupScript?: boolean;
  signal?: AbortSignal;
  setupAuthorized?: boolean;
  assertCurrent?: () => void;
  readNativeCredential?: GitHubCredentialReader;
  retainCredentialCleanup?: (revoke: () => Promise<void>) => void;
};

/** Admits one immutable allocation intent before the provider lifecycle can allocate a lease. */
export function createWorkerProviderIntent(options: WorkerProviderIntentOptions) {
  const preparedIntents = new WeakMap<
    WorkerProviderPreparedIntent,
    {
      profileId: string;
      assertCurrent: () => void;
      repository?: Awaited<ReturnType<typeof prepareRepositoryWorkerProjectSource>>;
    }
  >();
  const assertPreparedIntentCurrent = (profileId: string, intent: WorkerProviderPreparedIntent) => {
    const prepared = preparedIntents.get(intent);
    if (!prepared || prepared.profileId !== profileId) {
      throw serviceError("invalid_state", "Worker preparation is not owned by this lifecycle");
    }
    prepared.assertCurrent();
  };
  const { store, withLock, providerFor, resumeProvision } = options;
  const requireProfileId = (profileId: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (options.isStopping()) {
      throw serviceError("invalid_state", "Worker environment service is stopping");
    }
    const normalizedProfileId = profileId.trim();
    if (!normalizedProfileId || normalizedProfileId !== profileId) {
      throw serviceError("invalid_profile", "Worker profile id must be non-empty and trimmed");
    }
    return normalizedProfileId;
  };
  const resolveProfile = (
    profileId: string,
    createOptions: WorkerProviderIntentPreparationOptions,
  ) => {
    const normalizedProfileId = requireProfileId(profileId, createOptions.signal);
    const { inherited } = createOptions;
    let provider: WorkerProvider;
    let providerId: string;
    let profileSnapshot: WorkerProfile;
    const profiles = options.getConfig().cloudWorkers?.profiles;
    const configuredProfile =
      profiles && Object.hasOwn(profiles, normalizedProfileId)
        ? profiles[normalizedProfileId]
        : undefined;
    if (inherited) {
      providerId = normalizeCapabilityProviderId(inherited.providerId) ?? inherited.providerId;
      if (providerId !== inherited.providerId) {
        throw serviceError(
          "invalid_profile",
          "Inherited worker provider ID is not in the expected format",
        );
      }
      requireInheritedWorkerProfileAuthorization(
        normalizedProfileId,
        providerId,
        inherited.profileSnapshot.settings,
        configuredProfile?.provider,
      );
      provider = providerFor(providerId);
      const resolvedProviderId = normalizeCapabilityProviderId(provider.id) ?? provider.id;
      if (resolvedProviderId !== providerId) {
        throw serviceError("invalid_profile", "Inherited worker provider identity changed");
      }
      profileSnapshot = inherited.profileSnapshot;
    } else {
      if (!configuredProfile) {
        throw serviceError("profile_not_found", `Unknown worker profile: ${normalizedProfileId}`);
      }
      provider = providerFor(configuredProfile.provider);
      providerId = normalizeCapabilityProviderId(provider.id) ?? provider.id;
      profileSnapshot = configuredWorkerProfileSnapshot(configuredProfile);
    }
    return {
      provider,
      providerId,
      profileSnapshot: structuredClone(
        requireWorkerProfile(workerAllocationProfileSnapshot(profileSnapshot, createOptions)),
      ),
    };
  };

  const prepareIntent = async (
    profileId: string,
    createOptions: WorkerProviderIntentPreparationOptions = {},
  ): Promise<WorkerProviderPreparedIntent> => {
    const resolved = resolveProfile(profileId, createOptions);
    const { provider, providerId } = resolved;
    const { signal, projectPath } = createOptions;
    let profileSnapshot = resolved.profileSnapshot;
    const runSetupScript =
      profileSnapshot.runSetupScript === false ? false : createOptions.runSetupScript;
    const machineClass =
      typeof profileSnapshot.machineClass === "string" ? profileSnapshot.machineClass : undefined;
    const os = typeof profileSnapshot.os === "string" ? profileSnapshot.os : undefined;
    let repositoryAdmission:
      | Awaited<ReturnType<typeof prepareRepositoryWorkerProjectSource>>
      | undefined;
    const profile = requireWorkerProfile(profileSnapshot.settings);
    let assertImageCurrent: (() => void) | undefined;
    if (
      [
        projectPath,
        createOptions.repository,
        createOptions.projectRepository,
        createOptions.emptyWorkspace,
        createOptions.imageReserve,
      ].filter(Boolean).length > 1
    ) {
      throw serviceError(
        "invalid_profile",
        "Worker preparation must have exactly one project source",
      );
    }
    const supportsProjectPreparation =
      (!profileSnapshot.retention ||
        provider.supportsRetainedProjectImages?.(profile, machineClass, os) === true) &&
      provider.supportsProjectPreparation?.(profile, machineClass, os);
    if (
      (projectPath ||
        createOptions.repository ||
        createOptions.projectRepository ||
        ((createOptions.emptyWorkspace || createOptions.imageReserve) &&
          supportsProjectPreparation)) &&
      (supportsProjectPreparation || provider.runSetupCommand)
    ) {
      if (!options.projectNamespace) {
        throw serviceError("invalid_state", "Worker project preparation namespace is unavailable");
      }
      if (createOptions.repository || createOptions.projectRepository) {
        repositoryAdmission = await prepareRepositoryWorkerProjectSource({
          ...(createOptions.projectRepository
            ? { expected: createOptions.projectRepository }
            : { repository: createOptions.repository! }),
          namespace: options.projectNamespace,
          readNativeCredential: createOptions.readNativeCredential,
          retainCredentialCleanup: createOptions.retainCredentialCleanup,
          getConfig: options.getConfig,
          assertCurrent: () => {
            createOptions.assertCurrent?.();
            requireProfileId(profileId, signal);
          },
          signal,
          knownRecipe: (admittedProject) => {
            for (const record of store.list()) {
              const value = record.profileSnapshot.project;
              if (
                !isRecord(value) ||
                value.key !== admittedProject.key ||
                value.baseCommit !== admittedProject.baseCommit
              ) {
                continue;
              }
              const cached = readWorkerProjectSnapshot(value);
              const preparation = readWorkerProjectPreparation(value);
              if (
                cached &&
                "source" in cached &&
                preparation &&
                preparation.recipe &&
                isDeepStrictEqual(cached, admittedProject)
              ) {
                return {
                  setupRecipe: preparation.setupRecipe,
                  recipe: preparation.recipe,
                };
              }
            }
            return undefined;
          },
        });
      }
      const project =
        createOptions.emptyWorkspace || createOptions.imageReserve
          ? null
          : (repositoryAdmission?.project ??
            (projectPath
              ? await prepareWorkerProjectSnapshot({
                  localPath: projectPath,
                  namespace: options.projectNamespace,
                  baseCommit: createOptions.projectCommit,
                  signal,
                })
              : undefined));
      signal?.throwIfAborted();
      if (project !== undefined) {
        const target = provider.resolvePreparationTarget?.(profile, machineClass, os);
        const recipe = project
          ? "source" in project
            ? repositoryAdmission?.recipe
            : await readWorkerProjectEnvironmentRecipe(project, signal)
          : undefined;
        if (runSetupScript !== false) {
          assertEnvironmentRecipeSecretsMapped(recipe, profile.setupSecrets);
        }
        const setupRecipe = recipe?.identity;
        signal?.throwIfAborted();
        // Recipe execution needs authorization; ordinary checkout alone cannot fill a reserve.
        if (
          target &&
          provider.requiresNodeEnrollment &&
          options.prepareNodeArtifacts &&
          (!setupRecipe || runSetupScript === false || createOptions.setupAuthorized === true)
        ) {
          const admittedTarget = createOptions.imageReserve ? structuredClone(target) : undefined;
          const prepared = await options.prepareNodeArtifacts(profileSnapshot, signal);
          signal?.throwIfAborted();
          if (createOptions.imageReserve) {
            assertImageCurrent = () => {
              createOptions.assertCurrent?.();
              requireProfileId(profileId, signal);
              const current = resolveProfile(profileId, { ...createOptions, inherited: undefined });
              const currentProfile = requireWorkerProfile(current.profileSnapshot.settings);
              if (
                current.provider !== provider ||
                current.providerId !== providerId ||
                !isDeepStrictEqual(current.profileSnapshot, resolved.profileSnapshot) ||
                !provider.requiresNodeEnrollment ||
                !provider.supportsProjectPreparation?.(currentProfile, machineClass, os) ||
                !isDeepStrictEqual(
                  provider.resolvePreparationTarget?.(currentProfile, machineClass, os),
                  admittedTarget,
                )
              ) {
                throw serviceError("invalid_profile", "Runtime-only worker preparation changed");
              }
            };
            assertImageCurrent();
          }
          const preparation = createWorkerPreparationIdentity({
            namespace: options.projectNamespace,
            providerId,
            profileId,
            profileSnapshot,
            project:
              profileSnapshot.retention && !supportsProjectPreparation
                ? undefined
                : (project ?? undefined),
            ...(createOptions.imageReserve ? { imageReserve: true as const } : {}),
            target,
            artifacts: prepared.artifacts,
            // Private capacity prepares runtime only; repository setup belongs to session restore.
            ...(profileSnapshot.retention && !supportsProjectPreparation
              ? {}
              : { setupRecipe, recipe, runSetupScript }),
          });
          profileSnapshot =
            project && (!profileSnapshot.retention || supportsProjectPreparation)
              ? { ...resolved.profileSnapshot, project: { ...project, preparation } }
              : {
                  ...resolved.profileSnapshot,
                  runtimePreparation: {
                    source: createOptions.imageReserve ? "image" : "empty",
                    ...preparation,
                  },
                };
        } else if (project && supportsProjectPreparation) {
          profileSnapshot = { ...resolved.profileSnapshot, project };
        }
      }
    }
    const preparation = readWorkerPreparation(profileSnapshot);
    if (createOptions.imageReserve && !preparation) {
      throw serviceError(
        "invalid_profile",
        "Worker profile cannot prepare runtime-only image capacity",
      );
    }
    const intent = {
      providerId,
      profileSnapshot,
    };
    preparedIntents.set(intent, {
      profileId,
      repository: repositoryAdmission,
      // Private repository authority remains live; profile and plugin metadata
      // are the snapshot selected when preparation began.
      assertCurrent: () => {
        // Repository credentials belong to the original request. Local prepared
        // artifacts instead outlive their producer and are reused by async builds.
        if (repositoryAdmission) {
          createOptions.assertCurrent?.();
          signal?.throwIfAborted();
          repositoryAdmission.assertCurrent();
        }
        assertImageCurrent?.();
      },
    });
    return intent;
  };

  // Retention checks immutable contents against local policy/runtime facts.
  // Unknown observations throw; only confirmed incompatibility returns undefined/false.
  // This closure cannot authorize an allocation or claim private source.
  const prepareRetention = async (
    record: WorkerEnvironmentRecord,
    preparation: WorkerProjectPreparationIdentity,
    signal?: AbortSignal,
    onInvalid?: (reason: string) => void,
  ) => {
    const invalid = (reason: string) => {
      onInvalid?.(reason);
      return undefined;
    };
    const project = readWorkerProjectSnapshot(record.profileSnapshot.project);
    if (!options.prepareNodeArtifacts || !options.projectNamespace) {
      return invalid("preparation runtime is unavailable");
    }
    const projectPreparation = "source" in preparation ? undefined : preparation;
    const source = workerPreparationSourceKey(record.profileSnapshot);
    const createOptions: WorkerProviderIntentPreparationOptions = {
      ...(source === "image" ? { imageReserve: true as const } : {}),
      machineClass:
        typeof record.profileSnapshot.machineClass === "string"
          ? record.profileSnapshot.machineClass
          : undefined,
      os: typeof record.profileSnapshot.os === "string" ? record.profileSnapshot.os : undefined,
      executionMode:
        record.profileSnapshot.executionMode === "worker-turn" ||
        record.profileSnapshot.executionMode === "remote-exec"
          ? record.profileSnapshot.executionMode
          : undefined,
      signal,
    };
    signal?.throwIfAborted();
    const config = options.getConfig();
    const configured = config.cloudWorkers?.profiles?.[record.profileId];
    if (
      !configured ||
      normalizeCapabilityProviderId(configured.provider) !== record.providerId ||
      !isDeepStrictEqual(
        workerAllocationProfileSnapshot(configuredWorkerProfileSnapshot(configured), createOptions),
        workerAllocationProfileSnapshot(record.profileSnapshot, createOptions),
      )
    ) {
      return invalid("configured profile changed");
    }
    const isSourceOwnerCurrent = () => {
      const sourceConfig = options.getConfig();
      if (project && "source" in project) {
        const { agent, identity } = project.source.owner;
        const agentIdentity = resolveConfiguredGitHubToolIdentity({
          config: sourceConfig,
          agentId: agent.agentId,
          scope: "agent",
        });
        const systemIdentity = resolveConfiguredGitHubToolIdentity({
          config: sourceConfig,
          agentId: agent.agentId,
          scope: "system",
        });
        const selected = agentIdentity ?? systemIdentity;
        const selectedSource = agentIdentity ? "agent-override" : "system-configured";
        if (
          selected
            ? identity.source !== selectedSource ||
              !("profileId" in identity) ||
              identity.profileId !== selected.profileId
            : identity.source !== "anonymous" && identity.source !== "system-detected"
        ) {
          return false;
        }
      }
      return true;
    };
    if (!isSourceOwnerCurrent()) {
      return invalid("repository owner changed");
    }
    if (
      project &&
      "source" in project &&
      !(await matchesAgentLifecycleBindingAsync(options.getConfig, project.source.owner.agent))
    ) {
      return invalid("repository agent changed");
    }
    const resolved = resolveProfile(record.profileId, createOptions);
    const { provider, providerId, profileSnapshot } = resolved;
    const profile = requireWorkerProfile(profileSnapshot.settings);
    const target = provider.resolvePreparationTarget?.(
      profile,
      createOptions.machineClass,
      createOptions.os,
    );
    if (
      providerId !== record.providerId ||
      !target ||
      !isDeepStrictEqual(target, preparation.target) ||
      !provider.requiresNodeEnrollment ||
      !provider.supportsProjectPreparation?.(profile, createOptions.machineClass, createOptions.os)
    ) {
      return invalid("provider preparation target changed");
    }
    const prepared = await options.prepareNodeArtifacts(profileSnapshot, signal);
    const isCurrent = () => {
      if (source === "image") {
        try {
          const current = resolveProfile(record.profileId, createOptions);
          const currentProfile = requireWorkerProfile(current.profileSnapshot.settings);
          if (
            current.provider !== provider ||
            current.providerId !== providerId ||
            !isDeepStrictEqual(current.profileSnapshot, profileSnapshot) ||
            !provider.requiresNodeEnrollment ||
            !provider.supportsProjectPreparation?.(
              currentProfile,
              createOptions.machineClass,
              createOptions.os,
            ) ||
            !isDeepStrictEqual(
              provider.resolvePreparationTarget?.(
                currentProfile,
                createOptions.machineClass,
                createOptions.os,
              ),
              preparation.target,
            )
          ) {
            return false;
          }
        } catch {
          return false;
        }
      }
      return (
        isSourceOwnerCurrent() &&
        (!project ||
          !("source" in project) ||
          matchesAgentLifecycleBinding(options.getConfig(), project.source.owner.agent))
      );
    };
    if (!isCurrent()) {
      return invalid("repository owner changed during retention");
    }
    const observed = createWorkerPreparationIdentity({
      namespace: options.projectNamespace,
      providerId,
      profileId: record.profileId,
      profileSnapshot,
      project,
      ...(source === "image" ? { imageReserve: true as const } : {}),
      target,
      artifacts: prepared.artifacts,
      setupRecipe: projectPreparation?.setupRecipe,
      recipe: projectPreparation?.recipe,
      runSetupScript: projectPreparation?.runSetupScript,
    });
    return isDeepStrictEqual(project ? observed : { source, ...observed }, preparation)
      ? { isCurrent }
      : invalid("runtime artifacts or preparation identity changed");
  };

  const createWithProfile = async (
    profileId: string,
    idempotencyKey: string,
    createOptions: WorkerProviderIntentPreparationOptions = {},
    admittedIntent?: WorkerProviderPreparedIntent,
  ) => {
    const { machineClass, os, executionMode, projectPath, signal } = createOptions;
    const inherited = createOptions.inherited;
    const normalizedProfileId = requireProfileId(profileId, signal);
    const derived = deriveEnvironmentIntent(idempotencyKey);
    const originalDisk = createOptions.retainedWorkspaceAuthority;
    const environmentId = originalDisk?.environmentId ?? derived.environmentId;
    return withLock(environmentId, async () => {
      await store.ready();
      signal?.throwIfAborted();
      if (options.isStopping()) {
        throw serviceError("invalid_state", "Worker environment service is stopping");
      }
      let existing = store.get(environmentId);
      if (originalDisk && !existing) {
        throw new Error("Original retained worker owner is unavailable; replacement is refused");
      }
      if (existing) {
        const existingProject = readWorkerProjectSnapshot(existing.profileSnapshot.project);
        if (existingProject && projectPath) {
          if ("source" in existingProject) {
            throw serviceError("invalid_profile", "Idempotency key belongs to another project");
          }
          if (!options.projectNamespace) {
            throw serviceError(
              "invalid_state",
              "Worker project preparation namespace is unavailable",
            );
          }
          // Replay identifies the repository; it retains the already-admitted root and commit.
          const { commonDir } = await resolveGitRepositoryPaths(await fsp.realpath(projectPath), {
            signal,
          });
          signal?.throwIfAborted();
          if (workerLocalProjectKey(options.projectNamespace, commonDir) !== existingProject.key) {
            throw serviceError("invalid_profile", "Idempotency key belongs to another project");
          }
          if (
            createOptions.projectCommit !== undefined &&
            createOptions.projectCommit !== existingProject.baseCommit
          ) {
            throw serviceError(
              "invalid_profile",
              "Idempotency key belongs to another project preparation",
            );
          }
        }
        // Replay retains the captured allocation profile rather than retargeting it to current config.
        const imageReplay = workerPreparationSourceKey(existing.profileSnapshot) === "image";
        if (imageReplay && (projectPath || createOptions.emptyWorkspace)) {
          throw serviceError(
            "invalid_profile",
            "Idempotency key belongs to another project preparation",
          );
        }
        const requested =
          admittedIntent ??
          (createOptions.repository ||
          createOptions.projectRepository ||
          (createOptions.imageReserve && !imageReplay)
            ? await prepareIntent(profileId, createOptions)
            : undefined);
        if (requested) {
          signal?.throwIfAborted();
          assertPreparedIntentCurrent(profileId, requested);
          if (
            !originalDisk &&
            (!isDeepStrictEqual(
              workerProjectReplayIdentity(existing.profileSnapshot.project),
              workerProjectReplayIdentity(requested.profileSnapshot.project),
            ) ||
              !isDeepStrictEqual(
                existing.profileSnapshot.runtimePreparation,
                requested.profileSnapshot.runtimePreparation,
              ))
          ) {
            throw serviceError(
              "invalid_profile",
              "Idempotency key belongs to another project preparation",
            );
          }
        }
        if (
          existing.profileId !== normalizedProfileId ||
          (inherited !== undefined &&
            (existing.providerId !== inherited.providerId ||
              !isDeepStrictEqual(existing.profileSnapshot, {
                ...workerAllocationProfileSnapshot(inherited.profileSnapshot, createOptions),
                ...(existingProject ? { project: existing.profileSnapshot.project } : {}),
                ...(existing.profileSnapshot.runtimePreparation
                  ? { runtimePreparation: existing.profileSnapshot.runtimePreparation }
                  : {}),
              }))) ||
          (inherited === undefined &&
            (existing.profileSnapshot.machineClass !== machineClass ||
              existing.profileSnapshot.os !== os ||
              existing.profileSnapshot.executionMode !== executionMode))
        ) {
          throw serviceError("invalid_profile", "Idempotency key belongs to another profile");
        }
        if (originalDisk) {
          existing = await resumeOriginalRetainedWorkspaceOwner(
            existing,
            originalDisk,
            createOptions.retentionOwner,
            store,
            signal,
            requested ? () => assertPreparedIntentCurrent(profileId, requested) : undefined,
          );
        }
        if (existing.destroyRequestedAtMs !== null) {
          return existing;
        }
        if (!existing.leaseId && ["requested", "provisioning"].includes(existing.state)) {
          return resumeProvision(
            existing,
            undefined,
            signal,
            undefined,
            requested ? () => assertPreparedIntentCurrent(profileId, requested) : undefined,
            !originalDisk && requested ? preparedIntents.get(requested)?.repository : undefined,
            originalDisk,
          );
        }
        return existing;
      }
      const admitted =
        admittedIntent ??
        (await prepareIntent(profileId, {
          ...createOptions,
          setupAuthorized:
            createOptions.setupAuthorized ?? createOptions.runSetupScript !== undefined,
        }));
      signal?.throwIfAborted();
      assertPreparedIntentCurrent(profileId, admitted);
      const { providerId, profileSnapshot } = admitted;
      const provider = providerFor(providerId);
      const intent = await store.createIntent(
        {
          environmentId,
          providerId,
          profileId: normalizedProfileId,
          profileSnapshot,
          ...(profileSnapshot.retention
            ? {
                retention: createWorkerSessionDiskRetention({
                  provider,
                  policy:
                    options.getConfig().cloudWorkers?.profiles?.[normalizedProfileId]?.retention,
                  owner: createOptions.retentionOwner,
                  environmentId,
                  provisionOperationId: derived.provisionOperationId,
                }),
              }
            : {}),
          provisionOperationId: derived.provisionOperationId,
        },
        () => {
          signal?.throwIfAborted();
          assertPreparedIntentCurrent(profileId, admitted);
        },
      );
      return resumeProvision(
        intent,
        provider,
        signal,
        undefined,
        () => assertPreparedIntentCurrent(profileId, admitted),
        preparedIntents.get(admitted)?.repository,
      );
    });
  };
  return {
    prepareIntent,
    prepareRetention,
    assertPreparedIntentCurrent,
    createWithProfile,
    preparedRepositorySource(profileId: string, intent: WorkerProviderPreparedIntent) {
      assertPreparedIntentCurrent(profileId, intent);
      return preparedIntents.get(intent)?.repository;
    },
  };
}
