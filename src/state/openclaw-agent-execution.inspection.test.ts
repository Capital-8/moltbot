import fs from "node:fs";
import { afterEach, assert, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import * as inspection from "../config/sessions/session-entry-inspection.js";
import { readPreparedSessionEntryInspection } from "../config/sessions/session-entry-inspection.js";
import { historyLane } from "../config/sessions/session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabase } from "../config/sessions/session-transcript-worker-runtime.js";
import * as workerStore from "../infra/sqlite-worker-store.js";
import {
  assertAgentDatabaseAdmitted,
  createAgentDatabaseInspectionRefusal,
  publishPendingAgentDatabaseReadAdmission,
  recordAgentDatabaseAdmissions,
} from "./agent-database-admission.js";
import { withArtifactPreservingStateReads } from "./artifact-preserving-state-reads.js";
import {
  getOpenClawAgentDatabaseValidationForTransfer,
  invalidateOpenClawAgentDatabaseValidation,
} from "./openclaw-agent-db-validation-cache.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import type { AgentDatabaseRequestExecutionSource } from "./openclaw-agent-execution-admission-contract.js";
import type {
  AgentDatabaseOperations,
  PreparedAgentDatabaseExecution,
} from "./openclaw-agent-execution-contract.js";
import * as native from "./openclaw-agent-execution-native.js";
import { createNativeIntegritySource } from "./openclaw-agent-execution-native.test-support.js";
import {
  createAgentCreationWitnessFixture as fixture,
  createAgentCreationWitnessSource as source,
} from "./openclaw-agent-execution.creation-fixture.test-support.js";
import * as executions from "./openclaw-agent-execution.js";
import {
  captureOpenClawAgentDatabaseExecution as capture,
  captureExistingPreparedOpenClawAgentDatabaseExecution as capturePrepared,
} from "./openclaw-agent-execution.js";
import { runOpenClawAgentWorkerWrite } from "./openclaw-agent-write-admission.js";

afterEach(() => vi.restoreAllMocks());
const sessionKey = "agent:main:inspection";
type ReadInput = AgentDatabaseOperations["session.inspection.readPrepared"]["input"];

async function prepared() {
  const options = fixture();
  const writer = capture(options);
  try {
    await writer.prepare(source());
    await writer.runExisting(source(), (worker) =>
      worker.execute({
        type: "session.entries.replace",
        input: {
          expectedRows: new Map(),
          labelOwnerKeys: [],
          validationKeys: [sessionKey],
          replacements: [
            {
              sessionKey,
              entry: { sessionId: "inspection-session", updatedAt: 1, label: "committed" },
            },
          ],
        },
      }),
    );
    const execution = capturePrepared(options);
    assert(execution);
    const identity = execution.fileIdentity;
    assert(identity);
    const input: ReadInput = {
      kind: "session-exact-entries",
      database: { agentId: "main", path: options.path },
      env: options.env,
      sessionKeys: [sessionKey],
      preserveSourceArtifacts: true,
      validationReceiptId: getOpenClawAgentDatabaseValidationForTransfer(options)!.receiptId,
      expectedIdentity: {
        canonicalPath: options.path,
        key: "file:" + identity.physicalIdentity,
        birthtime: identity.birthtime,
      },
    };
    return { options, execution, input };
  } finally {
    await writer.release();
  }
}

const inspect = (
  execution: PreparedAgentDatabaseExecution,
  input: ReadInput,
  authority: AgentDatabaseRequestExecutionSource,
  admission?: Parameters<PreparedAgentDatabaseExecution["runExisting"]>[2],
) =>
  execution.runExisting(
    authority,
    (worker) => worker.execute({ type: "session.inspection.readPrepared", input }),
    admission,
  );

it("does not create or prepare missing, synchronous, or unprepared owners", async () => {
  const options = fixture();
  using creates = vi.spyOn(native, "createAgentDatabaseNativeGeneration");
  expect(capturePrepared(options)).toBeUndefined();
  expect(fs.existsSync(options.path)).toBe(false);
  const synchronous = openOpenClawAgentDatabase(options);
  expect(capturePrepared(options)).toBeUndefined();
  const unprepared = capture(options);
  try {
    expect(capturePrepared(options)).toBeUndefined();
    expect(synchronous.db.isOpen).toBe(true);
    expect(creates).not.toHaveBeenCalled();
  } finally {
    await unprepared.release();
  }
});

function useTransactionInspection() {
  const open = workerStore.openAgentDatabaseSqliteWorkerStore;
  return vi
    .spyOn(workerStore, "openAgentDatabaseSqliteWorkerStore")
    .mockImplementation((request, options) =>
      open(
        {
          ...request,
          moduleUrl: new URL(
            "./openclaw-agent-execution.inspection.test-support.ts",
            import.meta.url,
          ),
        },
        options,
      ),
    );
}

it("refuses inspection inside a real native transaction without damaging the prepared writer", async () => {
  using transaction = useTransactionInspection();
  const { execution, input } = await prepared();
  transaction.mockRestore();
  try {
    const authority = createNativeIntegritySource(
      () => execution.assertCurrent(),
      (request) => expect(request.stage).toBe("prepare"),
    );
    await expect(inspect(execution, input, authority)).resolves.toBeUndefined();
    const next = await execution.runExisting(authority, (worker) =>
      worker.execute({ type: "session.entry.read", input: { sessionKeys: [sessionKey] } }),
    );
    expect(next?.entries[0]?.entry.label).toBe("committed");
  } finally {
    await execution.release();
  }
});

it.each(["queued", "read-complete"] as const)(
  "settles a %s inspection before closing without preparing a successor",
  async (phase) => {
    const nativeClosed = Promise.withResolvers<void>();
    const create = native.createAgentDatabaseNativeGeneration;
    using creates = vi
      .spyOn(native, "createAgentDatabaseNativeGeneration")
      .mockImplementation((...args) => {
        const generation = create(...args);
        const close = generation.close.bind(generation);
        generation.close = async () => {
          await close();
          nativeClosed.resolve();
        };
        return generation;
      });
    const { options, execution, input } = await prepared();
    creates.mockClear();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const admissions: string[] = [];
    const authority = createNativeIntegritySource(
      () => execution.assertCurrent(),
      (request) => {
        admissions.push(request.stage);
        expect(request.stage).toBe("prepare");
      },
    );
    const reading = inspect(execution, input, authority, {
      withAdmission: async (run) => {
        if (phase === "queued") {
          entered.resolve();
          await release.promise;
          return run();
        }
        const value = await run();
        entered.resolve();
        await release.promise;
        return value;
      },
    });
    const outcome = reading.then(
      () => "disclosed",
      (error: unknown) => String(error),
    );
    let closing: Promise<void> | undefined;
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        reading,
        "Inspection settled before its held admission",
      );
      let settled = false;
      closing = closeOpenClawAgentDatabaseByPathAsync(options.path, options.agentId).then(() => {
        settled = true;
      });
      // Wait for the actual native close, not a timer or guessed count of microtasks.
      await nativeClosed.promise;
      expect(settled).toBe(false);
      expect(() => execution.assertCurrent()).toThrow(/closed|current/);
      release.resolve();
      expect(await outcome).toMatch(/closed|current/);
      await closing;
      expect(creates).not.toHaveBeenCalled();
      expect(admissions).toEqual(phase === "queued" ? [] : ["prepare"]);
      expect(capturePrepared(options)).toBeUndefined();
    } finally {
      release.resolve();
      await Promise.allSettled([reading, closing]);
      await execution.release();
    }
  },
);

it.each([
  "physical replacement",
  "validation revocation",
  "caller revocation",
  "caller abort",
] as const)("rejects %s without recreating or disclosing facts", async (change) => {
  const { options, execution, input } = await prepared();
  using creates = vi.spyOn(native, "createAgentDatabaseNativeGeneration");
  const admitted = createNativeIntegritySource(
    () => execution.assertCurrent(),
    (request) => expect(request.stage).toBe("prepare"),
  );
  expect((await inspect(execution, input, admitted))?.entries[0]?.entry.label).toBe("committed");
  let restore: (() => void) | undefined;
  try {
    if (change === "physical replacement") {
      const original = options.path + ".held-original";
      fs.renameSync(options.path, original);
      fs.copyFileSync(original, options.path);
      restore = () => {
        fs.unlinkSync(options.path);
        fs.renameSync(original, options.path);
      };
    } else if (change === "validation revocation") {
      invalidateOpenClawAgentDatabaseValidation(options.path);
    }
    const authority =
      change === "caller revocation"
        ? createNativeIntegritySource(() => {
            throw new Error("Caller authority revoked");
          })
        : admitted;
    const aborted = new AbortController();
    aborted.abort(new Error("Caller read aborted"));
    const reading =
      change === "caller abort"
        ? readPreparedSessionEntryInspection(
            input,
            () => execution.assertCurrent(),
            aborted.signal,
            60_000,
          )
        : inspect(execution, input, authority);
    await expect(reading).rejects.toThrow(/changed|identity|validation|revoked|aborted/i);
    expect(creates).not.toHaveBeenCalled();
  } finally {
    restore?.();
    await execution.release();
  }
});

function readPreserved(input: ReadInput) {
  return withArtifactPreservingStateReads(
    () =>
      withSessionHistoryWorkerDatabase({ ...input.database, env: input.env }, (reader) =>
        reader.readExactEntries(input),
      ),
    { agentDatabases: true },
  );
}

it.each(["admission", "release", "handoff"] as const)(
  "rejects validation revoked after SQL during %s before disclosing facts",
  async (phase) => {
    const { options, execution, input } = await prepared();
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const hold = async () => {
      entered.resolve();
      await resume.promise;
    };
    // Keep the actual native operation and cleanup; delay only their handoff.
    const originalCapture = executions.captureExistingPreparedOpenClawAgentDatabaseExecution;
    vi.spyOn(
      executions,
      "captureExistingPreparedOpenClawAgentDatabaseExecution",
    ).mockImplementation((target) => {
      const borrowed = originalCapture(target);
      assert(borrowed);
      if (phase === "admission") {
        const runExisting = borrowed.runExisting.bind(borrowed);
        borrowed.runExisting = (authority, operation, admission) =>
          runExisting(authority, operation, {
            withAdmission: async (run, signal) => {
              const value = await (admission?.withAdmission
                ? admission.withAdmission(run, signal)
                : run());
              await hold();
              return value;
            },
          });
      } else if (phase === "release") {
        const release = borrowed.release.bind(borrowed);
        borrowed.release = async () => {
          await release();
          await hold();
        };
      }
      return borrowed;
    });
    const read = inspection.readPreparedSessionEntryInspection;
    vi.spyOn(inspection, "readPreparedSessionEntryInspection").mockImplementation(
      async (...args) => {
        const result = await read(...args);
        if (phase === "handoff") {
          await hold();
        }
        return result;
      },
    );
    const reading = readPreserved(input);
    const outcome = reading.then(
      () => "disclosed",
      (error: unknown) => String(error),
    );
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        reading,
        "Read never reached its post-SQL handoff",
      );
      invalidateOpenClawAgentDatabaseValidation(options.path);
      resume.resolve();
      expect(await outcome).toMatch(/validation.*current/i);
    } finally {
      resume.resolve();
      await Promise.allSettled([reading]);
      await execution.release();
    }
  },
);

it("uses the private read fallback while startup read admission precedes a blocked writer", async () => {
  const { options, execution, input } = await prepared();
  await execution.release();
  await closeOpenClawAgentDatabaseByPathAsync(options.path, options.agentId);
  const unprepared = capture(options);
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const writing = runOpenClawAgentWorkerWrite(options, async () => {
    entered.resolve();
    await resume.promise;
  });
  await awaitGateBeforeSettlement(
    entered.promise,
    writing,
    "Writer did not acquire its reservation",
  );
  const refusal = createAgentDatabaseInspectionRefusal({
    agentId: options.agentId,
    paths: [options.path],
    reason: "Startup inspection pending",
    pending: true,
  });
  recordAgentDatabaseAdmissions([refusal], { ...options, source: "startup" });
  const revoke = publishPendingAgentDatabaseReadAdmission(refusal, {
    ...options,
    paths: [options.path],
    assertCurrent() {},
  });
  using creates = vi.spyOn(native, "createAgentDatabaseNativeGeneration");
  try {
    expect(() => assertAgentDatabaseAdmitted(options.agentId, options)).toThrow(/pending/i);
    const value = await readPreserved(input);
    expect(value.entries[0]?.entry.label).toBe("committed");
    expect(value.snapshotSource?.databaseIdentity).toBe(input.expectedIdentity.key.slice(5));
    expect(capturePrepared(options)).toBeUndefined();
    expect(creates).not.toHaveBeenCalled();
    revoke();
    await expect(readPreserved(input)).rejects.toThrow(/pending/i);
  } finally {
    revoke();
    recordAgentDatabaseAdmissions([], { ...options, source: "startup" });
    resume.resolve();
    await writing;
    await unprepared.release();
  }
});

it.each([
  ["transaction", "healthy"],
  ["canonical-unready", "healthy"],
  ["transaction", "release"],
  ["canonical-unready", "release"],
  ["transaction", "fallback"],
  ["canonical-unready", "fallback"],
] as const)("retains %s inspection custody through %s fallback", async (ineligible, phase) => {
  const transaction = ineligible === "transaction" ? useTransactionInspection() : undefined;
  const { options, execution, input } = await prepared();
  transaction?.mockRestore();
  const validation = getOpenClawAgentDatabaseValidationForTransfer(options);
  assert(validation);
  if (ineligible === "canonical-unready") {
    // Mutate the real receipt shared with the native getter, not its return value.
    Atomics.store(new Int32Array(validation.canonicalReady), 0, 0);
  }
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const hold = async () => {
    entered.resolve();
    await resume.promise;
  };
  if (phase === "release") {
    const original = executions.captureExistingPreparedOpenClawAgentDatabaseExecution;
    vi.spyOn(
      executions,
      "captureExistingPreparedOpenClawAgentDatabaseExecution",
    ).mockImplementation((target) => {
      const borrowed = original(target);
      assert(borrowed);
      const release = borrowed.release.bind(borrowed);
      borrowed.release = async () => {
        await release();
        await hold();
      };
      return borrowed;
    });
  }
  // The real history worker completes its private snapshot before the held handoff.
  const run = historyLane.pool.run.bind(historyLane.pool);
  const fallback = vi.spyOn(historyLane.pool, "run").mockImplementation(async (...args) => {
    const reply = await run(...args);
    expect(reply).toMatchObject({
      ok: true,
      value: {
        kind: "session-exact-entries",
        snapshotSource: { databaseIdentity: input.expectedIdentity.key.slice(5) },
      },
    });
    if (phase === "fallback") {
      await hold();
    }
    return reply;
  });
  const reading = readPreserved(input);
  const outcome = reading.then(
    (value) => ({ value }),
    (error: unknown) => ({ error: String(error) }),
  );
  try {
    if (phase === "healthy") {
      expect(await outcome).toMatchObject({
        value: { entries: [{ entry: { label: "committed" } }] },
      });
      expect(fallback).toHaveBeenCalledOnce();
    } else {
      await awaitGateBeforeSettlement(
        entered.promise,
        reading,
        "Inspection never reached its fallback handoff",
      );
      expect(Atomics.load(new Int32Array(validation.valid), 0)).toBe(1);
      invalidateOpenClawAgentDatabaseValidation(options.path);
      resume.resolve();
      expect(await outcome).toMatchObject({ error: expect.stringMatching(/validation.*current/i) });
      expect(fallback).toHaveBeenCalledTimes(phase === "release" ? 0 : 1);
    }
  } finally {
    resume.resolve();
    await Promise.allSettled([reading]);
    await execution.release();
  }
});
