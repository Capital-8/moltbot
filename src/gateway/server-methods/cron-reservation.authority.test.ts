import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { createDueIsolatedJob } from "../../../test/helpers/cron/service-regression-fixtures.js";
import { getAdmittedRunDelegatedAuthority } from "../../agents/admitted-run-context.js";
import { runWithCronCreatorAuthorityCapability } from "../../agents/cron-creator-authority-context.js";
import {
  captureGatewayToolCallerAssertion,
  withGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import { createCronMutationCompletion } from "../../cron/mutation-completion.js";
import { prepareCronRunAdmission } from "../../cron/run-admission.js";
import { TEST_SCHEDULED_EXECUTION } from "../../cron/scheduled-occurrence.test-support.js";
import { CronService } from "../../cron/service.js";
import { createBlockedCronRun } from "../../cron/service/ops.test-support.js";
import { validateAgentRunDelegatedAuthority } from "../../infra/agent-run-registry.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-approval-authority.js";
import {
  createCronCreatorAuthorityRunScope,
  mintCronCreatorAuthorityGrant,
  revokeCronCreatorAuthorityRunScope,
} from "../cron-creator-authority-grant.js";
import {
  captureGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
} from "../device-revocation.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
import { resolveCronMutationCommitGuard } from "./cron-caller-scope.js";
import { cronHandlers } from "./cron.js";
import type { RespondFn } from "./types.js";

afterEach(() => vi.restoreAllMocks());

it.each([
  "scheduled",
  "device",
  "device revoked",
  "owner ended",
  "owner revoked",
  "owner cancelled",
  "owner changed",
  "owner disabled",
  "owner deleted",
  "owner device revoked",
  "admin ended",
])("keeps accepted Cron custody and live revocation checks: %s", async (scenario) => {
  await withOpenClawTestState({ label: "cron-reservation-caller-authority" }, async (fixture) => {
    const now = Date.now();
    const target = createDueIsolatedJob({ id: "target", nowMs: now, nextRunAtMs: now });
    const queue = await createBlockedCronRun(fixture.statePath("cron", "jobs.json"), target, {
      defaultAgentId: "main",
      isAgentAvailable: () => true,
    });
    const cron = new CronService(queue.state.deps);
    const context = createDirectChatContext({
      cron,
      getRuntimeConfig: () => ({}),
      cronStorePath: queue.storePath,
      validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
    });
    const connection = new AbortController();
    const caller = captureGatewayDeviceRevocation(
      context,
      { deviceId: "queued-device", role: "operator" },
      () => true,
      connection.signal,
    );
    const admission = prepareCronRunAdmission({
      scheduledExecution: TEST_SCHEDULED_EXECUTION,
      cfg: {},
      runId: "queued-caller",
      agentId: "main",
      sessionKey: "cron:caller",
      jobId: "caller",
      deliveryAttemptFence: null,
    });
    const admitted = await admission.preparedRunAdmission.admit("gateway");
    const { operationalRunInstance } = admitted;
    const authority = expectDefined(getAdmittedRunDelegatedAuthority(admitted), "admitted run");
    let ownerCurrent = true;
    const scope = createCronCreatorAuthorityRunScope(
      operationalRunInstance.runId,
      { kind: "local" },
      scenario === "admin ended"
        ? { source: "control-ui-admin" }
        : { source: "channel-owner", isCurrent: () => ownerCurrent },
      caller.isCurrent,
    );
    const identity = {
      kind: "agentRuntime" as const,
      agentId: "main",
      sessionKey: "agent:main:main",
      operationalRunInstance,
      delegatedAuthority: { kind: "local" as const, ...authority },
      cronManagementGrant: mintCronCreatorAuthorityGrant(scope, undefined, undefined, {
        method: "cron.run",
        authority,
      }),
    };
    const client = createSyntheticPluginRuntimeClient({ scopes: ["operator.admin"] });
    if (scenario.startsWith("owner") || scenario === "admin ended") {
      client.internal = { agentRuntimeIdentity: identity };
    }
    if (scenario === "scheduled") {
      client.internal = { agentRuntimeIdentity: { ...identity, cronManagementGrant: undefined } };
    }
    const commitGuard = expectDefined(
      resolveCronMutationCommitGuard(
        scenario === "scheduled" ? client : null,
        context,
        undefined,
        scenario === "scheduled" ? undefined : { hasCurrentClientAuthority: caller.isCurrent },
      ),
      "caller guard",
    );
    const sql = observeMainThreadSql();
    sql.calibrate();
    try {
      const handler = expectDefined(cronHandlers["cron.run"], "cron.run");
      const completion = expectDefined(createCronMutationCompletion("cron.run"), "run");
      const respond = vi.fn<RespondFn>();
      await runWithCronCreatorAuthorityCapability(scope, () =>
        withGatewayToolCallerIdentity(
          {
            ...identity,
            approvalAuthority: authority,
            receiptAuthority: () => validateAgentRunDelegatedAuthority(authority),
          },
          () =>
            completion.run(async () =>
              handler({
                req: { type: "req", id: "queued-run", method: "cron.run" },
                params: { id: target.id, mode: "force" },
                context,
                client,
                respond,
                isWebchatConnect: () => false,
                hasCurrentClientAuthority: caller.isCurrent,
                sessionMutationCommitGuard:
                  scenario === "scheduled" ? undefined : captureGatewayToolCallerAssertion(),
              }),
            ),
        ),
      );
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ ok: true, enqueued: true, runId: expect.any(String) }),
        undefined,
      );
      expect(completion.isCommitted()).toBe(true);
      sql.clear();
      commitGuard();
      sql.expectIdle();
      const ack = respond.mock.calls[0]?.[1] as { runId: string };
      caller.release();
      connection.abort();
      expect(caller.isCurrent()).toBe(true);
      if (scenario.startsWith("owner") || scenario === "admin ended") {
        admission.close();
        ownerCurrent = scenario !== "owner revoked";
      }
      if (scenario === "owner cancelled") {
        scope.abort();
      }
      if (scenario.endsWith("device revoked")) {
        invalidateGatewayDeviceRevocation(context, "queued-device", "operator");
      }
      if (scenario === "owner changed") {
        await cron.update(target.id, { agentId: "other" });
      }
      if (scenario === "owner disabled") {
        await cron.update(target.id, { enabled: false });
      }
      if (scenario === "owner deleted") {
        await cron.remove(target.id);
      }
      await queue.finishActive();
      expect(await cron.waitForManualRun(ack.runId, 60_000)).toBe(true);
      expect(queue.targetCalls()).toHaveLength(
        ["scheduled", "device", "owner ended", "admin ended"].includes(scenario) ? 1 : 0,
      );
      expect((await queue.readJob())?.state.queuedAtMs).toBeUndefined();
      expect(caller.isCurrent()).toBe(false);
    } finally {
      sql.restore();
      caller.release();
      revokeCronCreatorAuthorityRunScope(scope);
      admission.close();
      if (scenario === "scheduled") {
        expect(commitGuard).toThrow("agent runtime authority is no longer active");
      }
      await queue.finishActive();
      cron.stop();
    }
  });
});
