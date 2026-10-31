import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  assignSessionOwner,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { cronRunLogEntryToDetail } from "../cron/run-history-detail.js";
import { recordCronRunInDatabase } from "../cron/store/run-history.kernel.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createCanonicalRepairFixture } from "./doctor-session-repair-fixture.test-support.js";

const literal = "agent:main:global";
function pair(stateDir: string, reviewId = "review-original") {
  const fixture = createCanonicalRepairFixture(stateDir);
  fixture.cfg.session = { ...fixture.cfg.session, scope: "global" };
  setRuntimeConfigSnapshot(fixture.cfg);
  const ongoing = {
    sessionId: "ongoing-original",
    updatedAt: 1,
    label: "Ongoing plan",
    delivery: { kind: "none" as const },
  };
  const review = {
    sessionId: reviewId,
    updatedAt: 2,
    label: "Independent review",
    delivery: { kind: "none" as const },
  };
  fixture.insert("global", ongoing, "ongoing history");
  fixture.insert(literal, review, "review history");
  return { ...fixture, ongoing, review };
}

it("recovers the overlapping review without replacing the ongoing chat or its retained state", async () => {
  await withOpenClawTestState({ prefix: "doctor-global-review-" }, async (state) => {
    const fixture = pair(state.stateDir);
    assignSessionOwner(
      { ...fixture.scope(), sessionKey: literal },
      {
        owner: { type: "human", id: "review-owner" },
        assignedBy: { type: "human", id: "creator" },
        assignedAt: 3,
      },
    );
    const database = fixture.database().db;
    database
      .prepare(
        "INSERT INTO session_members (session_key, identity_id, added_by, added_at) VALUES (?, ?, ?, ?)",
      )
      .run(literal, "review-member", "creator", 4);
    database
      .prepare(
        "INSERT INTO session_windows (session_id, session_key, reason, session_scope, created_at, updated_at) VALUES (?, ?, 'reset', 'conversation', 1, 1)",
      )
      .run("review-retained", literal);
    const before = [fixture.load("global"), fixture.load(literal)];
    await fixture.repair(false);
    expect([fixture.load("global"), fixture.load(literal)]).toEqual(before);
    const result = await fixture.repair();
    expect(fixture.load("global")).toEqual(before[0]);
    expect(fixture.load(literal)).toBeUndefined();
    const recovered = expectDefined(result.globalSessionRepairs?.[0], "recovered chat");
    expect(recovered.to).toMatch(/^agent:main:global-review-/);
    expect(fixture.load(recovered.to)?.entry).toEqual(before[1]?.entry);
    expect(
      database
        .prepare("SELECT session_id FROM session_windows WHERE session_key = ? ORDER BY session_id")
        .all(recovered.to),
    ).toEqual([{ session_id: "review-original" }, { session_id: "review-retained" }]);
    expect(
      database
        .prepare(
          "SELECT identity_id, added_by, added_at FROM session_members WHERE session_key = ?",
        )
        .all(recovered.to),
    ).toEqual([{ identity_id: "review-member", added_by: "creator", added_at: 4 }]);
    await fixture.transcript("global", fixture.ongoing.sessionId, "ongoing history");
    await fixture.transcript(recovered.to, fixture.review.sessionId, "review history");
    await fixture.repair();
    expect(fixture.load("global")).toEqual(before[0]);
    expect(fixture.load(recovered.to)?.entry).toEqual(before[1]?.entry);
    replaceSessionEntrySync(
      { ...fixture.scope(), sessionKey: recovered.to },
      { ...fixture.review, resumeAfterRestart: { queuedInputIds: [] } },
    );
    const busy = fixture.load(recovered.to);
    expect((await fixture.repair()).globalSessionRepairs).toBeUndefined();
    expect(fixture.load(recovered.to)).toEqual(busy);
    expect(fixture.load("global")).toEqual(before[0]);
  });
});

it("finishes an interrupted historical reference after the row rehome committed", async () => {
  await withOpenClawTestState({ prefix: "doctor-global-resume-" }, async (state) => {
    const fixture = pair(state.stateDir, "earlier-review-2");
    const earlierKey = expectDefined(
      (await fixture.repair()).globalSessionRepairs?.[0],
      "earlier repair",
    ).to;
    const earlier = fixture.load(earlierKey);
    fixture.review.sessionId = "review-original";
    fixture.insert(literal, fixture.review, "review history");
    const destination = expectDefined(
      (await fixture.repair()).globalSessionRepairs?.[0],
      "recovered review",
    ).to;
    const storeKey = path.join(state.stateDir, "cron", "jobs.json");
    const history = {
      storeKey,
      jobId: "review-job",
      runId: "retained-failed-run",
      agentId: "main",
      sessionKey: literal,
      startedAt: 10,
      endedAt: 20,
      status: "failed",
      detail: cronRunLogEntryToDetail(
        {
          ts: 20,
          jobId: "review-job",
          action: "finished",
          status: "error",
          sessionId: fixture.review.sessionId,
          runId: "retained-failed-run",
          runAtMs: 10,
        },
        { storeKey },
      ),
    };
    // Recreate the between-commit state through the real row repair and retained-run producer.
    const before = runOpenClawStateWriteTransaction(
      ({ db }) => {
        recordCronRunInDatabase(db, history);
        return db.prepare("SELECT * FROM task_runs WHERE agent_id = ?").all("main");
      },
      { env: fixture.env },
    );
    const ongoing = fixture.load("global");
    await fixture.repair();
    const after = runOpenClawStateWriteTransaction(
      ({ db }) => db.prepare("SELECT * FROM task_runs WHERE agent_id = ?").all("main"),
      { env: fixture.env },
    );
    const expected = before.map((row) =>
      Object.assign({}, row, { child_session_key: destination }),
    );
    expect(after).toEqual(expected);
    expect(fixture.load("global")).toEqual(ongoing);
    expect(fixture.load(destination)?.entry.sessionId).toBe(fixture.review.sessionId);
    expect(fixture.load(earlierKey)).toEqual(earlier);
    await fixture.transcript(destination, fixture.review.sessionId, "review history");
    expect((await fixture.repair()).globalSessionRepairs).toBeUndefined();
  });
});

it.each(["occupied", "linked", "resuming"] as const)(
  "refuses a %s precondition without changing either chat",
  async (kind) => {
    await withOpenClawTestState({ prefix: "doctor-global-refusal-" }, async (state) => {
      const fixture = pair(state.stateDir);
      const destination = expectDefined(
        (await fixture.repair(false)).globalSessionRepairs?.[0],
        "planned repair",
      ).to;
      if (kind === "occupied") {
        fixture.insert(destination, {
          sessionId: "unrelated",
          updatedAt: 3,
          delivery: { kind: "none" },
        });
      } else if (kind === "linked") {
        replaceSessionEntrySync(
          { ...fixture.scope(), sessionKey: "agent:main:child" },
          {
            sessionId: "child",
            updatedAt: 3,
            parentSessionKey: literal,
          },
        );
      } else {
        replaceSessionEntrySync(
          { ...fixture.scope(), sessionKey: literal },
          {
            ...fixture.review,
            resumeAfterRestart: { queuedInputIds: [] },
          },
        );
      }
      const before = [fixture.load("global"), fixture.load(literal), fixture.load(destination)];
      await expect(fixture.repair()).rejects.toThrow(/Cannot recover/);
      expect([fixture.load("global"), fixture.load(literal), fixture.load(destination)]).toEqual(
        before,
      );
    });
  },
);

it("leaves healthy raw, named and other-agent literal chats unchanged", async () => {
  await withOpenClawTestState({ prefix: "doctor-global-healthy-" }, async (state) => {
    const fixture = createCanonicalRepairFixture(state.stateDir, undefined, ["main", "ops"]);
    fixture.cfg.session = { ...fixture.cfg.session, scope: "global" };
    setRuntimeConfigSnapshot(fixture.cfg);
    const targets = [
      ["global", "main"],
      ["agent:main:ordinary", "main"],
      ["agent:ops:global", "ops"],
    ] as const;
    for (const [key, agentId] of targets) {
      fixture.insert(
        key,
        { sessionId: `original-${key}`, updatedAt: 1, delivery: { kind: "none" } },
        key,
        agentId,
      );
    }
    const before = targets.map(([key, agentId]) => fixture.load(key, agentId));
    expect((await fixture.repair()).globalSessionRepairs).toBeUndefined();
    expect(targets.map(([key, agentId]) => fixture.load(key, agentId))).toEqual(before);
  });
});
