import type { SqliteWorkerPreparedBackend } from "../infra/sqlite-worker-contract.js";
import { getOpenClawAgentDatabaseIfOpen } from "./openclaw-agent-db.js";
import type {
  AgentDatabaseExecutionOpen,
  AgentDatabaseOperations,
} from "./openclaw-agent-execution-contract.js";
import * as backend from "./openclaw-agent-execution.worker.js";

function withinTransaction(
  native: SqliteWorkerPreparedBackend<AgentDatabaseOperations>,
  input: AgentDatabaseExecutionOpen,
) {
  return {
    ...native,
    execute(command: Parameters<typeof native.execute>[0]) {
      if (command.type !== "session.inspection.readPrepared") {
        return native.execute(command);
      }
      const database = getOpenClawAgentDatabaseIfOpen({
        agentId: input.agentId,
        path: input.databasePath,
        env: input.environment,
      });
      if (!database) {
        throw new Error("Transaction fixture did not prepare its real native owner");
      }
      database.db.exec("BEGIN");
      try {
        return native.execute(command);
      } finally {
        database.db.exec("ROLLBACK");
      }
    },
  };
}

export const createSqliteWorkerBackend: typeof backend.createSqliteWorkerBackend = (
  input,
  opening,
) => withinTransaction(backend.createSqliteWorkerBackend(input, opening), input);
export const openExistingSqliteWorkerBackend: typeof backend.openExistingSqliteWorkerBackend = (
  input,
  opening,
) => withinTransaction(backend.openExistingSqliteWorkerBackend(input, opening), input);
