import { captureOpenClawAgentDatabaseReadValidation } from "../../state/openclaw-agent-db-validation-cache.js";
import { captureExistingPreparedOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import type { SessionExactEntriesWorkerInput } from "./session-entry-read.types.js";
import { MAX_SESSION_ROW_FACTS_KEYS } from "./session-transcript-worker.types.js";
import { createSessionWorkerExecutionSource } from "./session-worker-execution-source.js";

/** Ineligibility alone permits the existing private-copy path; custody failures propagate. */
export async function readPreparedSessionEntryInspection(
  input: SessionExactEntriesWorkerInput,
  assertReadCurrent: () => void,
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
) {
  if (
    input.selection ||
    input.manualCompact ||
    input.transcript ||
    input.replyInitializationSessionKey ||
    input.sessionKeys.length > MAX_SESSION_ROW_FACTS_KEYS ||
    (input.sourceChecks?.length ?? 0) > MAX_SESSION_ROW_FACTS_KEYS ||
    (input.projection !== undefined &&
      input.projection !== "full" &&
      input.projection !== "sharing" &&
      input.projection !== "exact")
  ) {
    return undefined;
  }
  assertReadCurrent();
  callerSignal?.throwIfAborted();
  const execution = captureExistingPreparedOpenClawAgentDatabaseExecution({
    ...input.database,
    env: input.env,
  });
  if (!execution) {
    return undefined;
  }
  const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs)));
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  let inspected;
  try {
    const claim = execution.captureGenerationClaim();
    const file = execution.fileIdentity;
    if (
      !file ||
      (input.expectedIdentity &&
        (input.expectedIdentity.key !== "file:" + file.physicalIdentity ||
          input.expectedIdentity.birthtime !== file.birthtime))
    ) {
      throw new Error("Session inspection source differs from its prepared owner");
    }
    const validation = captureOpenClawAgentDatabaseReadValidation(
      { agentId: input.database.agentId, path: file.nativeLocation },
      "prepared",
    );
    if (!validation) {
      throw new Error("Session inspection lost its admitted validation");
    }
    const assertDisclosureCurrent = () => {
      validation.assertCurrent();
      assertReadCurrent();
      signal.throwIfAborted();
    };
    const assertCurrent = () => {
      assertDisclosureCurrent();
      claim.assertCurrent();
    };
    const source = createSessionWorkerExecutionSource(
      assertCurrent,
      "Session inspection authority expired",
    );
    const value = await execution.runExisting(
      source,
      (worker) =>
        worker.execute(
          {
            type: "session.inspection.readPrepared",
            input: {
              ...input,
              validationReceiptId: validation.validation.receiptId,
              expectedIdentity: {
                canonicalPath: file.nativeLocation,
                key: "file:" + file.physicalIdentity,
                birthtime: file.birthtime,
              },
            },
          },
          { signal },
        ),
      {
        withAdmission: (run, queuedSignal) => {
          queuedSignal.throwIfAborted();
          assertCurrent();
          return run();
        },
      },
    );
    assertCurrent();
    inspected = { value, assertCurrent: assertDisclosureCurrent };
  } finally {
    await execution.release();
  }
  // Validation custody outlives the borrower, including idle-eviction waits during release.
  inspected.assertCurrent();
  return inspected;
}
