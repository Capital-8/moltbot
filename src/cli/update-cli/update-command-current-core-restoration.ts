import { formatErrorMessage } from "../../infra/errors.js";
import { recordUpdateRunDiagnostics } from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { defaultRuntime } from "../../runtime.js";
import {
  isUntouchedFailureRecovery,
  withCurrentCoreRestoration,
} from "./update-command-current-core-recovery.js";
import {
  shouldWaitForRecovery,
  verifyUpdateFailureRecovery,
} from "./update-command-failure-recovery.js";
import type { FinishUpdateParams } from "./update-command-finish-types.js";
import { UpdateCommandFailure } from "./update-command-result.js";
import type { UpdateServiceDefinitionRecovery } from "./update-command-service-context-types.js";
import type { PreManagedServiceStop } from "./update-command-service-maintenance.js";
import { maybeRestartServiceAfterFailedMutableUpdate } from "./update-command-service.js";

export async function restoreFailedUpdateService(state: {
  params: FinishUpdateParams;
  result: UpdateRunResult;
  currentCoreFailureRecovery: boolean;
  serviceStop: PreManagedServiceStop | undefined;
  onGatewayStartAttempted: (action?: "install" | "restart") => void;
  failure: (cause: unknown) => Error;
}): Promise<{ service?: "healthy" | "failed"; failure?: { cause: unknown } }> {
  const { params, result, currentCoreFailureRecovery, serviceStop, onGatewayStartAttempted } =
    state;
  // Consume the narrow permission before any native/custody await; never retry it.
  if (currentCoreFailureRecovery) {
    onGatewayStartAttempted("restart");
  }
  const service = await withCurrentCoreRestoration({
    enabled: currentCoreFailureRecovery,
    run: params.opts.run,
    result,
    failure: state.failure,
    restore: (currentCoreRisk, assertRecoverySafe) =>
      maybeRestartServiceAfterFailedMutableUpdate({
        currentCoreRisk,
        assertRecoverySafe,
        onGatewayStartAttempted,
        recovery: result.recovery,
        originalManagedServiceRuntime: params.originalManagedServiceRuntime,
        updateRun: params.opts.run,
        preManagedServiceStop: serviceStop,
        jsonMode: Boolean(params.opts.json),
        nodeRunner: params.packageUpdateNodeRunner,
        timeoutMs: params.updateStepTimeoutMs,
        invocationCwd: params.invocationCwd,
      }),
  });
  if (
    service === "healthy" &&
    currentCoreFailureRecovery &&
    params.opts.run &&
    result.recovery?.serviceRestartSafe === true
  ) {
    // An owned restoration, unlike passive observation, may settle this refusal.
    recordUpdateRunDiagnostics(
      params.opts.run.runId,
      { recovery: { ...result.recovery, service } },
      (message) => defaultRuntime.error(message),
      { env: params.opts.run.env },
    );
  }
  if (
    service &&
    !params.originalManagedServiceRuntime &&
    result.recovery?.serviceRestartSafe === true
  ) {
    result.recovery = { ...result.recovery, service };
    if (service === "failed") {
      result.status = "error";
      try {
        await serviceStop?.windowsTaskAutoStartRecovery?.complete(false);
      } catch (cause) {
        return { service, failure: { cause } };
      }
    }
  }
  return { service };
}

// Preserve the independent observation used for unchanged, mutable and unknown
// callers. This does not grant the narrow current-core restoration permission.
export function observeFinalizerFailure(
  params: FinishUpdateParams,
  state: {
    result: UpdateRunResult;
    root: string;
    serviceStop: PreManagedServiceStop | undefined;
    gatewayStartAttempted: "install" | "restart" | undefined;
    definitionRecovery: UpdateServiceDefinitionRecovery;
    rollbackAttempted: boolean;
    rolledBack: boolean;
    assertCurrent: () => void;
  },
) {
  return verifyUpdateFailureRecovery({
    result: state.result,
    root: state.root,
    opts: params.opts,
    env: state.serviceStop?.serviceEnv ?? params.ownedManagedUpdateEnv,
    timeoutMs: params.updateStepTimeoutMs,
    untouchedFailure: isUntouchedFailureRecovery(params, state.serviceStop, state),
    serviceStopped: !state.rolledBack && state.serviceStop?.stopped,
    serviceUpdateVerdict: state.gatewayStartAttempted
      ? undefined
      : state.serviceStop?.serviceUpdateVerdict,
    waitForStartup: shouldWaitForRecovery(params, state.serviceStop, state.rollbackAttempted),
    assertCurrent: state.assertCurrent,
  });
}

// Pure reporting transform: no restart, ownership or recovery admission effects.
export function recordWindowsTaskRestorationFailure(
  result: UpdateRunResult,
  originalResult: UpdateRunResult,
  root: string,
  cause: unknown,
): void {
  result.status = "error";
  result.reason =
    originalResult.status === "error"
      ? originalResult.reason
      : "windows-task-autostart-restore-failed";
  result.recovery = { serviceRestartSafe: false, reason: "runtime-verification-failed" };
  result.steps = result.steps.concat({
    name: "windows-task-autostart-recovery",
    command: "openclaw update",
    cwd: result.root ?? root,
    durationMs: 0,
    exitCode: 1,
    stderrTail: formatErrorMessage(cause),
  });
}

// Diagnostic publication never changes recovery authority or hides its failure.
export async function publishRestorationFailure(
  error: unknown,
  deferred: boolean,
  publish: (failure: unknown) => Promise<UpdateRunResult>,
): Promise<never> {
  if (!deferred && error instanceof UpdateCommandFailure) {
    try {
      await publish(error);
    } catch (publicationError) {
      throw new AggregateError(
        [error, publicationError],
        "Restoration and diagnostic publication failed.",
        { cause: publicationError },
      );
    }
  }
  throw error;
}
