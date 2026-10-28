// Doctor and runtime share record policy without loading a state-store implementation.
import { createHash } from "node:crypto";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { crabboxWarmImageCaptureAdmission } from "./crabbox-worker-warm-image-debt.js";
import type { WarmProfileRecord } from "./crabbox-worker-warm-image-store.js";

export const WARM_IMAGE_MAX_ENTRIES = 128;
export const LEGACY_WARM_LEASE_MAX_ENTRIES = 256;

export function crabboxLegacyWarmImageCaptureSelector(key: string, record: unknown): string {
  return `legacy-${createHash("sha256").update(JSON.stringify({ key, record })).digest("hex")}`;
}

// Recovery selectors bind the original row bytes; preserve property order and prefixes.
export const legacyLeaseSelector = (key: string, value: unknown) =>
  `legacy-lease-${createHash("sha256").update(JSON.stringify({ key, value })).digest("hex")}`;

export function projectCrabboxLegacyWarmLeases(
  entries: readonly { key: string; value: unknown }[],
) {
  return entries.map(({ key, value }) => ({
    leaseId: key,
    machineClass:
      isRecord(value) && typeof value.machineClass === "string" ? value.machineClass : undefined,
    selector: legacyLeaseSelector(key, value),
  }));
}

export const hasNoCrabboxWarmImageProviderObligations = (record: WarmProfileRecord) =>
  !record.image &&
  !record.previous &&
  !record.operation &&
  !record.retirements?.length &&
  Object.keys(record.allocations).length === 0;

const CAPTURE_WARNING_AGE_MS = 1_200_000;

export const isCrabboxWarmImageHeld = (
  record: Pick<WarmProfileRecord, "allocations">,
  checkpointId: string,
) =>
  Object.values(record.allocations).some(
    ({ choice, imageGeneration }) =>
      (choice.kind === "checkpoint" && choice.checkpointId === checkpointId) ||
      imageGeneration?.checkpointId === checkpointId,
  );

export function crabboxWarmImageCaptureStatus(record: WarmProfileRecord) {
  const capture = record.operation?.type === "capture" ? record.operation : undefined;
  if (!capture) {
    return undefined;
  }
  return {
    selector: capture.id,
    startedAtMs: capture.startedAtMs,
    ...(capture.leaseId ? { leaseId: capture.leaseId } : {}),
    ...(capture.provider ? { provider: capture.provider } : {}),
    phase: capture.phase,
    stale: Date.now() - capture.startedAtMs >= CAPTURE_WARNING_AGE_MS,
  };
}

export const CRABBOX_WARM_IMAGE_WAIT_HINT =
  "The capture may still be preparing its source or waiting for provider readiness. Inspect openclaw crabbox warm-images --json and allow the owning capture to settle.";

export function crabboxWarmImageRecoveryHint(selector: string): string {
  return `Stop the owning Gateway and capture processes, confirm any worker being recovered is stopped, and reconcile any untracked checkpoint or snapshot in its original provider scope (the Crabbox catalog for CLI checkpoints, Azure snapshot inventory for SDK snapshots) before running: openclaw crabbox warm-images --recover ${selector} --acknowledge-provider-cleanup. Then restart the Gateway; the next eligible worker can capture again.`;
}

export function projectCrabboxWarmImage(key: string, value: WarmProfileRecord) {
  const captureAdmission = crabboxWarmImageCaptureAdmission(value);
  return {
    profileKey: key,
    profileId: value.profileId,
    backend: value.backend,
    machineClass: value.machineClass,
    os: value.os,
    projectLabel: value.projectLabel,
    projectRoot: value.projectRoot,
    projectKey: value.projectKey,
    recipePreparation: value.recipePreparation,
    recipePreparationAtMs: value.recipePreparationAtMs,
    checkpointId: value.image?.checkpointId,
    state: value.image?.state ?? "no-image",
    createdAtMs: value.image?.createdAtMs,
    preparationKey: value.image?.preparationKey,
    cacheKey: value.image?.cacheKey,
    purpose: value.image?.purpose,
    lastDemandAtMs: value.image?.lastDemandAtMs,
    baseCommit: value.image?.baseCommit,
    runtimeIdentity: value.image?.runtimeIdentity,
    pinned: value.image?.pinned,
    previous: value.previous
      ? {
          checkpointId: value.previous.checkpointId,
          createdAtMs: value.previous.createdAtMs,
          baseCommit: value.previous.baseCommit,
          runtimeIdentity: value.previous.runtimeIdentity,
          pinned: value.previous.pinned,
          held: isCrabboxWarmImageHeld(value, value.previous.checkpointId),
        }
      : undefined,
    allocations: Object.fromEntries(
      Object.entries(value.allocations).map(([id, allocation]) => {
        const {
          azureSnapshotBinding: _privateBinding,
          retentionOwnerBinding: _retainedOwner,
          ...publicAllocation
        } = allocation;
        return [id, publicAllocation];
      }),
    ),
    capture: crabboxWarmImageCaptureStatus(value),
    captureUnsupported: value.captureUnsupported,
    latestColdReason: value.latestColdReason,
    retirement: value.retirements?.[0]
      ? { checkpointId: value.retirements[0].checkpointId }
      : undefined,
    retirements: (value.retirements ?? []).map((debt) => ({
      checkpointId: debt.checkpointId,
      held: isCrabboxWarmImageHeld(value, debt.checkpointId),
    })),
    captureAdmission: {
      structurallyEligible: captureAdmission === undefined,
      blockedReason: captureAdmission ?? null,
    },
  };
}
