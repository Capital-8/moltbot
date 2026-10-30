import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import {
  loadSessionEntryReadOnly,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { readTranscriptEventMessage } from "../config/sessions/session-accessor.sqlite-read.js";
import { makeCronJob } from "../cron/delivery.test-helpers.js";
import { cronRunResultEvent } from "../cron/store/run-result.js";
import {
  captureGatewayRootWorkReleaseObserver,
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { dispatchGatewayCronFinishedNotifications } from "./server-cron-notifications.js";

beforeEach(resetGatewayWorkAdmission);
afterEach(resetGatewayWorkAdmission);

it.each([
  { name: "false condition", status: "ok", hasTrigger: true, error: undefined, notice: false },
  {
    name: "disabled request",
    status: "skipped",
    hasTrigger: false,
    error: "Cron job disabled by operator.",
    notice: true,
  },
  {
    name: "failed condition",
    status: "error",
    hasTrigger: true,
    error: "cron trigger evaluation failed (execution_error): synthetic failure",
    notice: true,
  },
] as const)("preserves conversation delivery for $name", async (scenario) => {
  await withOpenClawTestState(
    { layout: "state-only", label: "cron-condition-notice" },
    async (state) => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:condition-notice",
        sessionId: "condition-notice",
        storePath: path.join(state.sessionsDir(), "sessions.json"),
      };
      const cfg = {
        agents: { entries: { main: { workspace: state.workspaceDir } } },
        session: { store: scope.storePath },
      };
      setRuntimeConfigSnapshot(cfg);
      await replaceSessionEntry(scope, {
        sessionId: scope.sessionId,
        lifecycleRevision: "condition-notice-generation",
        updatedAt: 1,
      });
      const job = makeCronJob({ sessionKey: scope.sessionKey });
      const evt = cronRunResultEvent(job, {
        job,
        jobId: job.id,
        status: scenario.status,
        error: scenario.error,
        triggerEval: scenario.hasTrigger ? { fired: false, stateChanged: false } : undefined,
        completionStatus: scenario.status === "ok" ? "succeeded" : "failed",
        startedAt: 10,
        endedAt: 20,
        deliveryState: {
          status: "not-requested",
          failureNotification: { status: "not-requested" },
        },
      });
      const settled = createDeferred();
      const logger = { warn: vi.fn() };
      dispatchGatewayCronFinishedNotifications({
        evt,
        job,
        runNotStarted: true,
        resolveCronAgent: () => {
          const observe = captureGatewayRootWorkReleaseObserver();
          expect(observe).not.toBeNull();
          observe?.(() => settled.resolve());
          return { agentId: scope.agentId, cfg };
        },
        logger,
      });
      if (getActiveGatewayRootWorkCount() > 0) {
        await settled.promise;
      }
      const messages = (await loadTranscriptEvents(scope)).filter(
        (event) => readTranscriptEventMessage(event)?.role === "assistant",
      );
      const entry = loadSessionEntryReadOnly({ ...scope, readConsistency: "latest" });
      expect(logger.warn).not.toHaveBeenCalled();
      if (scenario.notice) {
        expect(messages).toHaveLength(1);
        expect(JSON.stringify(messages)).toContain(`did not start: ${scenario.error}`);
        expect(entry?.updatedAt).toBeGreaterThan(1);
      } else {
        expect(messages).toEqual([]);
        expect(entry?.updatedAt).toBe(1);
      }
    },
  );
});
