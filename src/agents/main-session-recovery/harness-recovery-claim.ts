import { isDeepStrictEqual } from "node:util";
import { resolveRestartRecoveryChannelAuthority } from "../../config/sessions/restart-recovery-state.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { AdmittedRunContext } from "../admitted-run-context.js";

export type HarnessRestartRecoveryClaim = Readonly<{
  sourceRunId: string;
  recoveryRunId: string;
  assertCurrent: () => void;
}>;

const claims = new WeakMap<AdmittedRunContext, HarnessRestartRecoveryClaim>();

/** Attach only after private Gateway recovery admission, to the exact operational instance. */
export function bindHarnessRestartRecoveryClaim(params: {
  admitted: AdmittedRunContext;
  entry: InternalSessionEntry;
  interruptedRunId: string;
  attempt: number;
  lifecycleGeneration: string;
  readCurrent: () => InternalSessionEntry | undefined;
}): void {
  const { entry, admitted } = params;
  const recoveryRunId = admitted.operationalRunInstance.runId;
  const sourceTurnId = entry.restartRecoveryDeliverySourceRunId;
  const sourceRunId = params.interruptedRunId;
  const cycleId = entry.mainRestartRecovery?.cycleId;
  if (!sourceRunId || !cycleId || entry.restartRecoveryDeliveryRunId !== recoveryRunId) {
    return;
  }
  const ingress = entry.restartRecoverySourceIngress;
  const channel = resolveRestartRecoveryChannelAuthority(entry);
  if (ingress === "channel" && !channel) {
    return;
  }
  const sessionId = entry.sessionId;
  const revision = entry.lifecycleRevision;
  const sender = entry.restartRecoveryRequesterSenderId;
  const account = entry.restartRecoveryRequesterAccountId;
  const sameChannelThread = entry.restartRecoverySameChannelThreadRequired;
  claims.set(
    admitted,
    Object.freeze({
      sourceRunId,
      recoveryRunId,
      assertCurrent() {
        const current = params.readCurrent();
        if (
          !current ||
          current.sessionId !== sessionId ||
          current.lifecycleRevision !== revision ||
          current.status !== "running" ||
          current.abortedLastRun ||
          current.lifecycleRunId !== recoveryRunId ||
          current.mainRestartRecovery?.cycleId !== cycleId ||
          current.mainRestartRecovery.chargedAttempts !== params.attempt ||
          current.mainRestartRecovery.tombstone ||
          current.restartRecoveryDeliverySourceRunId !== sourceTurnId ||
          current.restartRecoveryDeliveryRunId !== recoveryRunId ||
          current.restartRecoverySourceIngress !== ingress ||
          current.restartRecoveryRequesterSenderId !== sender ||
          current.restartRecoveryRequesterAccountId !== account ||
          current.restartRecoverySameChannelThreadRequired !== sameChannelThread ||
          !isDeepStrictEqual(resolveRestartRecoveryChannelAuthority(current), channel) ||
          !current.restartRecoveryRuns?.some(
            (run) =>
              run.runId === recoveryRunId && run.lifecycleGeneration === params.lifecycleGeneration,
          )
        ) {
          throw new Error("Restart recovery no longer owns the original task");
        }
      },
    }),
  );
}

export function getHarnessRestartRecoveryClaim(
  admitted: AdmittedRunContext,
  assertHostActive: () => void,
): HarnessRestartRecoveryClaim | undefined {
  const claim = claims.get(admitted);
  return (
    claim &&
    Object.freeze({
      ...claim,
      assertCurrent() {
        assertHostActive();
        claim.assertCurrent();
      },
    })
  );
}
