import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { assertEngineStoreExecutionAllowed } from "../../infra/database-engine/admission-scope.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { WorkerRunnerCapacityError, type WorkerTunnelHandle } from "./tunnel-contract.js";
import {
  attachedEnvironment,
  cleanupWorkerTurnLauncherTest,
  createWorkerSessionTurnPlacementProvider,
  createWorkerTurnTunnel,
  credential,
  placements,
  seedActivePlacement,
  sessionTarget,
  setupWorkerTurnLauncherTest,
  turn,
  unusedEnvironments,
} from "./worker-turn-launcher.test-support.js";

afterAll(closeStateDatabaseForTest);
beforeEach(setupWorkerTurnLauncherTest);
afterEach(() => cleanupWorkerTurnLauncherTest({ reuseReadWorkers: true }));

it("prepares fresh and follow-up worker turns without Gateway-thread database queries", async () => {
  await seedActivePlacement();
  const launchTurn = vi.fn<NonNullable<WorkerTunnelHandle["launchTurn"]>>(async () => {
    throw new WorkerRunnerCapacityError();
  });
  const tunnel = createWorkerTurnTunnel({
    launchTurn,
    runWorkspaceCommand: vi.fn(),
    quiesceWorkspace: vi.fn(),
    syncWorkspace: vi.fn(),
    reconcileWorkspace: vi.fn(),
    stop: vi.fn(),
  });
  const provider = createWorkerSessionTurnPlacementProvider({
    placements,
    environments: {
      ...unusedEnvironments(),
      get: attachedEnvironment,
      acquireTurnCredential: async () => credential(),
      startTunnel: async () => tunnel,
    },
  });
  const sql = observeMainThreadSql({ onStatement: assertEngineStoreExecutionAllowed });
  try {
    for (const runId of ["fresh-pg-boundary", "followup-pg-boundary"]) {
      const input = turn(runId);
      try {
        await expect(
          provider.executeTurn({ ...sessionTarget, runId: input.runId }, input, vi.fn()),
        ).rejects.toBeInstanceOf(WorkerRunnerCapacityError);
      } finally {
        input.preparedRunAdmission.close();
      }
    }
    expect(launchTurn).toHaveBeenCalledTimes(2);
  } finally {
    sql.restore();
  }
});
