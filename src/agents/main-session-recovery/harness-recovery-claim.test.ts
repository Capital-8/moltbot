import { describe, expect, it, vi } from "vitest";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { createOperationalRunInstanceRef } from "../admitted-run-context.js";
import {
  bindHarnessRestartRecoveryClaim,
  getHarnessRestartRecoveryClaim,
} from "./harness-recovery-claim.js";

describe("harness recovery custody", () => {
  const admitted = { operationalRunInstance: createOperationalRunInstanceRef("recover") };
  const entry: InternalSessionEntry = {
    sessionId: "session",
    updatedAt: 1,
    status: "running",
    lifecycleRunId: "recover",
    restartRecoverySourceIngress: "channel",
    restartRecoveryDeliveryContext: { channel: "slack", to: "channel:C1", threadId: "original" },
    restartRecoveryDeliverySourceRunId: "original",
    restartRecoveryDeliveryRunId: "recover",
    restartRecoveryRuns: [{ runId: "recover", lifecycleGeneration: "epoch" }],
    mainRestartRecovery: { cycleId: "cycle", chargedAttempts: 1, revision: 1 },
  };

  it.each(["original-host-run", "recover"])(
    "requires the current operational instance and generation for interrupted run %s",
    (interruptedRunId) => {
      let current: InternalSessionEntry | undefined = entry;
      const assertActive = vi.fn();
      bindHarnessRestartRecoveryClaim({
        admitted,
        entry,
        interruptedRunId,
        attempt: 1,
        lifecycleGeneration: "epoch",
        readCurrent: () => current,
      });
      const claim = getHarnessRestartRecoveryClaim(admitted, assertActive);
      expect(getHarnessRestartRecoveryClaim({ ...admitted }, assertActive)).toBeUndefined();
      expect(claim?.sourceRunId).toBe(interruptedRunId);
      claim!.assertCurrent();
      for (const changed of [
        { restartRecoveryDeliverySourceRunId: "another" },
        {
          restartRecoveryDeliveryContext: {
            ...entry.restartRecoveryDeliveryContext,
            threadId: "another",
          },
        },
        { restartRecoveryRuns: [{ runId: "recover", lifecycleGeneration: "replacement" }] },
        { lifecycleRevision: "successor-revision" },
        { abortedLastRun: true },
      ]) {
        current = { ...entry, ...changed };
        expect(() => claim!.assertCurrent()).toThrow(/no longer owns/);
      }
      current = undefined;
      expect(() => claim!.assertCurrent()).toThrow(/no longer owns/);
      current = entry;
      assertActive.mockImplementation(() => {
        throw new Error("host retired");
      });
      expect(() => claim!.assertCurrent()).toThrow("host retired");
    },
  );
});
