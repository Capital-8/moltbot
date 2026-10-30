import { formatErrorMessage } from "../infra/errors.js";
import {
  isSqliteWorkerError,
  retainSqliteWorkerErrorCode,
} from "../infra/sqlite-worker-contract.js";
import { notifyListeners } from "../shared/listeners.js";
import { AgentDatabaseExecutionAdmissionClosedError } from "./agent-database-admission-error.js";

export function reportAgentDatabaseCleanupFailure(
  log: { warn(message: string): void },
  error: unknown,
): void {
  // Diagnostic failures cannot turn a committed command into a replayable failure.
  try {
    log.warn(`Agent database cleanup failed: ${formatErrorMessage(error)}`);
  } catch {
    // The resource owner still retains the cleanup failure.
  }
}

/** The executor keeps accepted work until its borrower or resource close joins settlement. */
export function createAgentDatabaseAcceptedWork() {
  const pending = new Map<
    Promise<unknown>,
    { borrower: symbol; queuedReadAbort?: AbortController }
  >();
  return {
    reportTerminal(terminalListeners: Set<(reason: Error) => void>, error: unknown) {
      if (terminalListeners.size === 0) {
        return;
      }
      const reason = error instanceof Error ? error : new Error(formatErrorMessage(error));
      const listeners = [...terminalListeners];
      terminalListeners.clear();
      // Never join this notification from close/run: their accepted work must settle first.
      void Promise.resolve().then(async () => {
        await Promise.allSettled(pending.keys());
        notifyListeners(listeners, reason);
      });
    },
    pending,
    settleBorrower: (borrower: symbol) =>
      Promise.allSettled(
        [...pending].flatMap(([work, owner]) => (owner.borrower === borrower ? [work] : [])),
      ),
    cancelReadAdmissions: (borrower?: symbol) => {
      for (const work of pending.values()) {
        if (borrower === undefined || work.borrower === borrower) {
          work.queuedReadAbort?.abort(
            new AgentDatabaseExecutionAdmissionClosedError(
              "Agent database read admission is closed",
            ),
          );
        }
      }
    },
    closeAccepted: async (close: () => Promise<void>) => {
      const reads = [...pending].flatMap(([work, owner]) => (owner.queuedReadAbort ? [work] : []));
      // A default prepare may await this close during backoff; native close owns its settlement.
      const nativeClose = close();
      await Promise.allSettled([nativeClose, ...reads]);
      await nativeClose;
    },
  };
}

export function agentDatabaseOperationCleanupFailure(error: unknown, cleanupError: unknown): Error {
  const primary = error instanceof Error ? error : new Error(String(error));
  const failure = Object.assign(
    new Error(primary.message, {
      cause: new AggregateError([error, cleanupError], "Agent operation and cleanup failed", {
        cause: error,
      }),
    }),
    { name: primary.name },
  );
  // Cleanup failures preserve the primary presentation without granting a retry.
  return isSqliteWorkerError(error, "outcome-unknown")
    ? retainSqliteWorkerErrorCode(failure, error)
    : failure;
}
