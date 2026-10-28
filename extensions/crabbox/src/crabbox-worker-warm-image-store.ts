import { isDeepStrictEqual } from "node:util";
import type { OpenClawPluginApi, WorkerProvider } from "openclaw/plugin-sdk/plugin-entry";
import type {
  PluginStateCompareIntent,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import type {
  AzureSandboxImage,
  AzureSandboxAllocationBinding,
  AzureSandboxCaptureAdmission,
} from "./crabbox-worker-azure-snapshot-binding.js";
import type { CrabboxOperatingSystem } from "./crabbox-worker-profile.js";
import { admitCrabboxWarmImageProfile } from "./crabbox-worker-warm-image-admission.js";
import {
  assertCrabboxWarmImageRowBudget,
  isCrabboxImageRetiring,
} from "./crabbox-worker-warm-image-debt.js";
import {
  normalizeRecipePreparation,
  type CrabboxProjectPreparationMetadata,
  type RecipePreparation,
} from "./crabbox-worker-warm-image-recipe.js";
import {
  legacyLeaseSelector,
  LEGACY_WARM_LEASE_MAX_ENTRIES,
  projectCrabboxLegacyWarmLeases,
  WARM_IMAGE_MAX_ENTRIES,
  crabboxWarmImageCaptureStatus,
  projectCrabboxWarmImage,
} from "./crabbox-worker-warm-image-records.js";

export {
  admitCrabboxWarmImageProfile,
  isCrabboxWarmProfileV3,
  upgradeCrabboxWarmProfileV3,
} from "./crabbox-worker-warm-image-admission.js";

export type CrabboxState = Pick<OpenClawPluginApi["runtime"]["state"], "openKeyedStoreV2">;

type WorkerNodeRuntimeIdentity = NonNullable<
  NonNullable<Parameters<WorkerProvider["provision"]>[2]>["nodeRuntimeIdentity"]
>;
export type WarmStartStatus = Parameters<
  NonNullable<NonNullable<Parameters<WorkerProvider["provision"]>[2]>["reportStartStatus"]>
>[0];
export type WarmColdReason = Extract<WarmStartStatus, { mode: "cold" }>["reason"];

export type WarmImageRecord = {
  checkpointId: string;
  kind: string;
  state: "pending" | "available";
  createdAtMs: number;
  preparationKey: string | null;
  cacheKey: string | null;
  purpose: "session" | "reserve" | null;
  lastDemandAtMs: number | null;
  pinned?: { atMs: number };
  baseCommit?: string;
  /** Runtime content attested by successful preparation before this capture. */
  runtimeIdentity?: WorkerNodeRuntimeIdentity;
  azureSandbox?: AzureSandboxImage;
};

export type WarmAllocationRecord = {
  coldReason?: WarmColdReason;
  choice: { kind: "cold" } | { kind: "checkpoint"; checkpointId: string };
  machineClass: string;
  /** Absent in existing Linux allocations. */
  os?: CrabboxOperatingSystem;
  phase: "pending" | "prepared" | "enrolled";
  /** Failed detected setup must never be published, including during teardown. */
  captureSkipped?: string;
  preparationKey: string | null;
  cacheKey: string | null;
  purpose: "session" | "reserve" | null;
  demandAtMs: number | null;
  imageGeneration: { checkpointId: string; createdAtMs: number } | null;
  /** A cold preparation may replace only the image observed at its admission. */
  publicationBase?: { checkpointId: string; createdAtMs: number };
  baseCommit?: string;
  /** Frozen target; preparation/enrollment must verify it before capture can publish it. */
  runtimeIdentity?: WorkerNodeRuntimeIdentity;
  azureSnapshotBinding?: AzureSandboxAllocationBinding;
  /** Terminal CLI observations fence rejected bindings separately from unknown effects. */
  snapshotPreflightOutcome?: { generation: string; outcome: "rejected" | "unknown" };
  /** This private allocation cannot become a reusable capture source. */
  retentionOwnerBinding?: string;
  timingIdentity?: { operationId: string; environmentId?: string };
};

export type WarmRetirementRecord = {
  type: "retire";
  checkpointId: string;
  azureSandbox?: AzureSandboxImage;
};

export type WarmProfileRecord = {
  version: 4;
  latestColdReason?: WarmColdReason;
  /** Configured profile that most recently allocated from this key; display only. */
  profileId?: string;
  backend?: string;
  machineClass?: string;
  os?: CrabboxOperatingSystem;
  projectLabel?: string;
  projectRoot?: string;
  projectKey?: string;
  recipePreparation?: RecipePreparation;
  recipePreparationAtMs?: number;
  image?: WarmImageRecord;
  previous?: WarmImageRecord;
  /** Latest native-capture refusal; retained for display without suppressing later attempts. */
  captureUnsupported?: { atMs: number; provider: string; message: string };
  allocations: Record<string, WarmAllocationRecord>;
  retirements?: WarmRetirementRecord[];
  operation?: {
    type: "capture";
    id: string;
    startedAtMs: number;
    leaseId?: string;
    provider?: string;
    phase: "scrubbing" | "creating" | "uncertain";
    azureSnapshotCapture?: AzureSandboxCaptureAdmission;
  };
};

export type WarmProfileV3 = Omit<WarmProfileRecord, "version" | "retirements" | "operation"> & {
  version: 3;
  operation?: WarmProfileRecord["operation"] | WarmRetirementRecord;
};

export class CrabboxWarmImageRequestError extends Error {}
// Match the former enrollment registry's capacity without evicting replay obligations;
// 256 bounded lease records leave ample room under the plugin store's 1 MiB row limit.
const WARM_IMAGE_MAX_ALLOCATIONS = 256;

const openLegacyLeases = (state: CrabboxState, env?: NodeJS.ProcessEnv) =>
  state.openKeyedStoreV2<unknown>({
    namespace: "warm-leases",
    maxEntries: LEGACY_WARM_LEASE_MAX_ENTRIES,
    overflowPolicy: "evict-oldest",
    ...(env ? { env } : {}),
  });
export async function listCrabboxLegacyWarmLeases(state: CrabboxState, env?: NodeJS.ProcessEnv) {
  return projectCrabboxLegacyWarmLeases(await openLegacyLeases(state, env).entries());
}

export async function assertCrabboxWarmImageMigrationReady(state: CrabboxState): Promise<void> {
  const leases = openLegacyLeases(state);
  if ((await leases.count()) > 0) {
    throw new Error(
      "Crabbox has legacy worker allocations whose original image choices are unknown; run openclaw doctor --fix and follow its provider-cleanup recovery instructions before provisioning workers.",
    );
  }
}

export const isCrabboxCaptureRefusalRetained = (
  record: WarmProfileRecord,
  refreshAfterMs: number,
): boolean =>
  record.captureUnsupported !== undefined &&
  Date.now() < record.captureUnsupported.atMs + refreshAfterMs;

/** Crabbox diagnostics follow Go error style without a final period. */
export const crabboxCaptureUnsupportedSentence = (message: string) =>
  `${message.replace(/[.\s]+$/u, "")}.`;

export const sameCrabboxWarmImageGeneration = (
  left: WarmAllocationRecord["imageGeneration"] | undefined,
  right: WarmAllocationRecord["imageGeneration"] | undefined,
) => left?.checkpointId === right?.checkpointId && left?.createdAtMs === right?.createdAtMs;

export function withCrabboxWarmImageGeneration(
  record: WarmProfileRecord | undefined,
  generation: WarmAllocationRecord["imageGeneration"] | undefined,
  update: (image: WarmImageRecord) => WarmImageRecord | undefined,
): WarmProfileRecord | undefined {
  if (!record || !generation) {
    return undefined;
  }
  const field = sameCrabboxWarmImageGeneration(record.image, generation) ? "image" : "previous";
  const image = record[field];
  if (!image || !sameCrabboxWarmImageGeneration(image, generation)) {
    return undefined;
  }
  const next = update(image);
  return next ? { ...record, [field]: next } : undefined;
}

export function assertCrabboxWarmImagePreparation(
  preparation:
    | { key: string; cacheKey: string; purpose: "session" | "reserve"; demandAtMs: number }
    | undefined,
  allocation: { projectKey?: string; target: CrabboxOperatingSystem },
): void {
  if (
    preparation &&
    (!allocation.projectKey ||
      allocation.target !== "linux" ||
      !/^[a-f0-9]{64}$/u.test(preparation.key) ||
      !/^[a-f0-9]{64}$/u.test(preparation.cacheKey) ||
      (preparation.purpose !== "session" && preparation.purpose !== "reserve") ||
      !Number.isSafeInteger(preparation.demandAtMs) ||
      preparation.demandAtMs < 0)
  ) {
    throw new Error("Crabbox project preparation identity is invalid.");
  }
}

/** A provision retry keeps the profile, project, and runtime identity its lease first recorded. */
export function assertCrabboxWarmImageReplay(
  replay: WarmAllocationRecord & { key: string },
  request: Pick<
    WarmAllocationRecord,
    | "machineClass"
    | "preparationKey"
    | "cacheKey"
    | "purpose"
    | "runtimeIdentity"
    | "retentionOwnerBinding"
  > & { key: string; os: CrabboxOperatingSystem; demandAtMs?: number },
): void {
  if (
    replay.key !== request.key ||
    replay.machineClass !== request.machineClass ||
    (replay.os ?? "linux") !== request.os ||
    replay.preparationKey !== request.preparationKey ||
    replay.cacheKey !== request.cacheKey ||
    replay.retentionOwnerBinding !== request.retentionOwnerBinding ||
    replay.purpose !== request.purpose ||
    (request.demandAtMs !== undefined && replay.demandAtMs !== request.demandAtMs)
  ) {
    throw new Error("Crabbox provision retry changed its recorded profile or project identity.");
  }
  if (!isDeepStrictEqual(replay.runtimeIdentity, request.runtimeIdentity)) {
    throw new Error(
      "Crabbox provision retry changed or lacks its recorded node runtime identity; stop the worker before reprovisioning",
    );
  }
}

type WarmProfileDisplayFacts = Pick<
  WarmProfileRecord,
  "profileId" | "backend" | "machineClass" | "os" | "projectLabel" | "projectRoot"
>;

export function withCrabboxWarmImageDisplayFacts(
  record: WarmProfileRecord,
  facts: WarmProfileDisplayFacts = {},
): WarmProfileRecord {
  const next = { ...record, ...facts };
  // Unavailable facts clear stale labels; plugin state cannot persist undefined values.
  for (const field of [
    "profileId",
    "backend",
    "machineClass",
    "os",
    "projectLabel",
    "projectRoot",
  ] as const) {
    if (next[field] === undefined) {
      delete next[field];
    }
  }
  return next;
}

async function compareProfile<T>(
  store: PluginStateKeyedStore<T, 2>,
  key: string,
  prepare: (current: T | undefined) => PluginStateCompareIntent<T>,
): Promise<boolean> {
  let observation = await store.observe(key);
  for (;;) {
    const result = await store.compareAndApply(
      key,
      observation.comparison,
      prepare(observation.value),
    );
    if (result.status !== "conflict") {
      return result.status === "applied";
    }
    // Only an explicit comparison conflict can retry; uncertain writes must settle with their owner.
    observation = result.current;
  }
}

export function openCrabboxWarmImageStore(state: CrabboxState, env?: NodeJS.ProcessEnv) {
  const store = state.openKeyedStoreV2<WarmProfileRecord>({
    namespace: "warm-images",
    maxEntries: WARM_IMAGE_MAX_ENTRIES,
    overflowPolicy: "reject-new",
    ...(env ? { env } : {}),
  });
  const canonical = {
    count: () => store.count(),
    deleteIf(key: string, predicate: (current: WarmProfileRecord) => boolean) {
      return compareProfile(store, key, (current) => ({
        operation: "delete",
        action: current && predicate(admitCrabboxWarmImageProfile(current)!) ? "delete" : "keep",
      }));
    },
    async lookup(key: string) {
      return admitCrabboxWarmImageProfile(await store.lookup(key));
    },
    async entries() {
      const entries = await store.entries();
      for (const entry of entries) {
        entry.value = admitCrabboxWarmImageProfile(entry.value)!;
      }
      return entries;
    },
    update(
      key: string,
      update: (current: WarmProfileRecord | undefined) => WarmProfileRecord | undefined,
    ) {
      return compareProfile(store, key, (current) => {
        const value = update(admitCrabboxWarmImageProfile(current));
        if (value) {
          assertCrabboxWarmImageRowBudget(value);
        }
        return value === undefined
          ? { operation: "update", action: "keep" }
          : { operation: "update", action: "set", value };
      });
    },
  };
  const lookupLease = async (id: string) => {
    const entries = (await canonical.entries()).filter(({ value }) =>
      Object.hasOwn(value.allocations, id),
    );
    if (entries.length > 1) {
      throw new Error(
        `Crabbox lease ${id} has conflicting warm-image owners; run openclaw doctor --fix.`,
      );
    }
    const entry = entries[0];
    return entry
      ? { key: entry.key, projectKey: entry.value.projectKey, ...entry.value.allocations[id]! }
      : undefined;
  };

  const markPhase = async (
    id: string,
    phase: "prepared" | "enrolled",
    baseCommit?: string,
    assertCurrent?: () => void,
    metadata?: CrabboxProjectPreparationMetadata,
  ) => {
    const recipePreparation = normalizeRecipePreparation(metadata?.recipePreparation);
    const owner = await lookupLease(id);
    if (!owner) {
      return;
    }
    if (
      phase === "prepared" &&
      (!baseCommit || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(baseCommit))
    ) {
      throw new Error("Crabbox project preparation requires a verified Git commit.");
    }
    let rejection: string | undefined;
    await canonical.update(owner.key, (record) => {
      assertCurrent?.();
      rejection = undefined;
      const allocation = record?.allocations[id];
      if (!record || !allocation) {
        rejection = "Crabbox allocation closed before preparation completed.";
        return undefined;
      }
      if (record.operation?.type === "capture" && record.operation.leaseId === id) {
        rejection = "Crabbox allocation cannot enroll while its image capture is unresolved.";
        return undefined;
      }
      if (baseCommit && allocation.baseCommit && baseCommit !== allocation.baseCommit) {
        rejection = "Crabbox provision retry changed its prepared Git commit.";
        return undefined;
      }
      if (
        phase === "enrolled" &&
        record.projectKey &&
        allocation.phase === "pending" &&
        !allocation.retentionOwnerBinding
      ) {
        rejection = "Crabbox project allocation must be prepared before enrollment.";
        return undefined;
      }
      // A private lease only borrowed clean image caches. Its required workspace
      // restoration belongs to placement admission after node enrollment.
      return {
        ...record,
        ...(recipePreparation ? { recipePreparation, recipePreparationAtMs: Date.now() } : {}),
        allocations: {
          ...record.allocations,
          [id]: {
            ...allocation,
            phase: allocation.phase === "enrolled" ? "enrolled" : phase,
            ...(baseCommit ? { baseCommit } : {}),
            ...(metadata?.captureSkipped
              ? { captureSkipped: metadata.captureSkipped.slice(0, 1024) }
              : {}),
          },
        },
      };
    });
    if (rejection) {
      throw new Error(rejection);
    }
  };

  return {
    ...canonical,
    lookupLease,
    async noteRecipePreparation(
      id: string,
      metadata: RecipePreparation,
      assertCurrent: () => void,
    ) {
      const recipePreparation = normalizeRecipePreparation(metadata);
      const owner = await lookupLease(id);
      if (!owner || !recipePreparation) {
        return;
      }
      await canonical.update(owner.key, (record) => {
        assertCurrent();
        return record?.allocations[id]
          ? { ...record, recipePreparation, recipePreparationAtMs: Date.now() }
          : undefined;
      });
    },
    async recordAllocation(params: {
      key: string;
      id: string;
      projectKey?: string;
      availableImage?: WarmImageRecord;
      coldReason?: WarmColdReason;
      displayFacts?: WarmProfileDisplayFacts;
      allocation: Omit<WarmAllocationRecord, "choice" | "imageGeneration">;
      assertCurrent: () => void;
    }) {
      let rejection: string | undefined;
      let owner: Awaited<ReturnType<typeof lookupLease>>;
      await canonical.update(params.key, (current) => {
        params.assertCurrent();
        rejection = undefined;
        owner = undefined;
        const record = withCrabboxWarmImageDisplayFacts(
          current ?? {
            version: 4,
            allocations: {},
            ...(params.projectKey ? { projectKey: params.projectKey } : {}),
          },
          params.displayFacts,
        );
        const existing = Object.hasOwn(record.allocations, params.id)
          ? record.allocations[params.id]
          : undefined;
        if (existing) {
          owner = {
            key: params.key,
            projectKey: record.projectKey,
            ...existing,
          };
          return params.displayFacts ? record : undefined;
        }
        if (Object.keys(record.allocations).length >= WARM_IMAGE_MAX_ALLOCATIONS) {
          rejection =
            "Crabbox warm-image allocation capacity is full; stop outstanding workers before retrying.";
          return undefined;
        }
        // Verification happened before this transaction; its image may have changed or retired.
        const choice: WarmAllocationRecord["choice"] =
          params.availableImage &&
          record.image &&
          sameCrabboxWarmImageGeneration(record.image, params.availableImage) &&
          !isCrabboxImageRetiring(record, record.image.checkpointId)
            ? { kind: "checkpoint", checkpointId: record.image.checkpointId }
            : { kind: "cold" };
        const allocation: WarmAllocationRecord = {
          choice,
          ...(choice.kind === "cold"
            ? { coldReason: params.coldReason ?? "snapshot-unavailable" }
            : {}),
          ...params.allocation,
          imageGeneration:
            choice.kind === "checkpoint"
              ? { checkpointId: choice.checkpointId, createdAtMs: record.image!.createdAtMs }
              : null,
          ...(choice.kind === "cold" && record.image
            ? {
                publicationBase: {
                  checkpointId: record.image.checkpointId,
                  createdAtMs: record.image.createdAtMs,
                },
              }
            : {}),
        };
        owner = {
          key: params.key,
          projectKey: record.projectKey,
          ...allocation,
        };
        return {
          ...record,
          ...(choice.kind === "cold"
            ? { latestColdReason: params.coldReason ?? "snapshot-unavailable" }
            : {}),
          allocations: { ...record.allocations, [params.id]: allocation },
        };
      });
      // Publish only the rejection from the observation accepted by the store.
      if (rejection) {
        throw new Error(rejection);
      }
      if (!owner) {
        throw new Error("Crabbox allocation was not recorded.");
      }
      return owner;
    },
    markPrepared(
      id: string,
      baseCommit: string,
      assertCurrent?: () => void,
      metadata?: CrabboxProjectPreparationMetadata,
    ) {
      return markPhase(id, "prepared", baseCommit, assertCurrent, metadata);
    },
    markEnrolled: (id: string, assertCurrent?: () => void) =>
      markPhase(id, "enrolled", undefined, assertCurrent),
    async notePreparedDemand(
      id: string,
      preparation: { preparationKey: string; demandAtMs: number },
    ) {
      const owner = await lookupLease(id);
      const generation = owner?.imageGeneration;
      if (
        !owner ||
        owner.phase !== "enrolled" ||
        owner.preparationKey !== preparation.preparationKey ||
        owner.cacheKey === null ||
        !generation ||
        !Number.isSafeInteger(preparation.demandAtMs) ||
        preparation.demandAtMs < 0
      ) {
        return;
      }
      // Assignment has no fork: refresh only the generation selected or produced
      // by this lease, even after demotion; never renew a different publication.
      await canonical.update(owner.key, (record) =>
        record &&
        record.allocations[id]?.preparationKey === owner.preparationKey &&
        record.allocations[id]?.cacheKey === owner.cacheKey &&
        record.allocations[id]?.purpose === owner.purpose &&
        record.allocations[id]?.phase === "enrolled" &&
        sameCrabboxWarmImageGeneration(record.allocations[id]?.imageGeneration, generation)
          ? withCrabboxWarmImageGeneration(record, generation, (image) =>
              image.cacheKey === owner.cacheKey
                ? {
                    ...image,
                    lastDemandAtMs: Math.max(image.lastDemandAtMs ?? 0, preparation.demandAtMs),
                  }
                : undefined,
            )
          : undefined,
      );
    },
  };
}

export function withoutCrabboxWarmImageOperation(record: WarmProfileRecord): WarmProfileRecord {
  const profile = { ...record };
  delete profile.operation;
  return profile;
}

export async function listCrabboxWarmImages(state: CrabboxState, env?: NodeJS.ProcessEnv) {
  return (await openCrabboxWarmImageStore(state, env).entries()).map(({ key, value }) =>
    projectCrabboxWarmImage(key, value),
  );
}

/** Recovery closes only the capture generation; allocation decisions remain authoritative. */
export async function clearCrabboxWarmImageCapture(
  store: ReturnType<typeof openCrabboxWarmImageStore>,
  key: string,
  selector: string,
): Promise<boolean> {
  const matches = (current: WarmProfileRecord) =>
    current.operation?.type === "capture" && current.operation.id === selector;
  if (
    await store.deleteIf(
      key,
      (current) =>
        !current.image &&
        !current.previous &&
        !current.retirements?.length &&
        Object.keys(current.allocations).length === 0 &&
        matches(current),
    )
  ) {
    return true;
  }
  return store.update(key, (current) =>
    current && matches(current) ? withoutCrabboxWarmImageOperation(current) : undefined,
  );
}

export async function recoverCrabboxWarmImageCapture(
  state: CrabboxState,
  selector: string,
  acknowledgeProviderCleanup: boolean,
): Promise<void> {
  if (!acknowledgeProviderCleanup) {
    throw new Error(
      "Recovery requires --acknowledge-provider-cleanup: confirm the original Gateway/capture processes and any worker being recovered are stopped, and any untracked provider artifact has been resolved. No state was changed.",
    );
  }
  if (selector.startsWith("legacy-lease-")) {
    const store = openLegacyLeases(state);
    const entry = (await store.entries()).find(
      ({ key, value }) => legacyLeaseSelector(key, value) === selector,
    );
    if (
      !entry ||
      !(await compareProfile(store, entry.key, (value) => ({
        operation: "delete",
        action:
          value !== undefined && legacyLeaseSelector(entry.key, value) === selector
            ? "delete"
            : "keep",
      })))
    ) {
      throw new Error(
        "Legacy allocation selector is absent or changed; rerun openclaw crabbox warm-images --json. No state was changed.",
      );
    }
    return;
  }
  const store = openCrabboxWarmImageStore(state);
  const entry = (await store.entries()).find(
    ({ value }) => crabboxWarmImageCaptureStatus(value)?.selector === selector,
  );
  if (!entry || !(await clearCrabboxWarmImageCapture(store, entry.key, selector))) {
    throw new Error(
      "Capture selector is absent or changed; rerun openclaw crabbox warm-images --json. No state was changed.",
    );
  }
}
