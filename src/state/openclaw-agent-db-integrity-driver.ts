import { isMainThread } from "node:worker_threads";
import {
  runSqliteIntegrityOperationSync,
  type SqliteIntegrityOperation,
} from "../infra/sqlite-integrity.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseRepairAdmission,
} from "./openclaw-agent-db-contract.js";
import type { PreparedOpenClawAgentDatabaseWorkerLease } from "./openclaw-agent-db-lease.types.js";

/** Keep synchronous generator resumption bound to the caller's original authority. */
export function runPreparedAgentDatabaseIntegrity(
  steps: SqliteIntegrityOperation<OpenClawAgentDatabase>,
  preparedLease: PreparedOpenClawAgentDatabaseWorkerLease | undefined,
  repairAdmission: OpenClawAgentDatabaseRepairAdmission | undefined,
  assertAuthority: (
    steps: SqliteIntegrityOperation<OpenClawAgentDatabase>,
    assertCurrent?: () => void,
  ) => void,
): OpenClawAgentDatabase {
  const assertCurrent = () => {
    repairAdmission?.assertCurrent?.();
    if (preparedLease && !isMainThread) {
      requestSqliteWorkerOperationAdmission({
        stage: "prepare",
        facts: { kind: "agent-open-resume", lease: preparedLease.receipt },
      });
    }
  };
  const repair = preparedLease?.startupRepair;
  return runSqliteIntegrityOperationSync(
    steps,
    (preparedLease && !isMainThread) || repairAdmission?.assertCurrent
      ? () => assertAuthority(steps, assertCurrent)
      : undefined,
    repair && !isMainThread ? (check, error) => repair(check, error, assertCurrent) : undefined,
  );
}
