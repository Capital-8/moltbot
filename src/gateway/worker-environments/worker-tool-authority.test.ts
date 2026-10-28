import assert from "node:assert/strict";
import { AsyncResource } from "node:async_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../agents/test-helpers/fast-bash-tools.js";
import "../../agents/test-helpers/fast-coding-tools.js";
import { finalizeAgentToolAvailability } from "../../agents/agent-tool-availability.js";
import { bindAgentToolExecutionLocation } from "../../agents/agent-tool-metadata.js";
import { createOpenClawCodingToolsInternal } from "../../agents/agent-tools.js";
import type { AnyAgentTool } from "../../agents/agent-tools.types.js";
import { resolveNodeExecutionTarget } from "../../agents/bash-tools.exec-host-node-phases.js";
import * as conversationPolicy from "../../agents/conversation-capability-profile.js";
import { applyEmbeddedAttemptToolsAllow } from "../../agents/embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { createAgentHarnessToolSurfaceRuntimeCore } from "../../agents/harness/tool-surface-bridge.js";
import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
import { createInstalledSkillTools } from "../../agents/tools/installed-skill-tools.js";
import {
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { createFixtureSkillEntry } from "../../skills/test-support/test-helpers.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createWorkerGatewayToolProxies } from "../../worker/worker-gateway-tools.js";
import { createWorkerPlacementTools } from "../../worker/worker-placement-tools.js";
import { createTranscriptCommitIdentity } from "./transcript-commit.test-support.js";
import { createWorkerGatewayToolRuntime } from "./worker-gateway-tool-runtime.js";
import { resolveWorkerToolAuthority } from "./worker-tool-authority.js";
import { captureWorkerTurnInputAuthority } from "./worker-turn-payload.js";
import { withWorkerTurnTranscriptDatabase } from "./worker-turn-transcript-target.js";

const gatewayMocks = vi.hoisted(() => ({ callGatewayTool: vi.fn() }));
type TurnOverrides = Partial<SessionPlacementTurnParams>;
const modelRef = { provider: "openai", model: "gpt-test" };
const placement = { agentId: "main", sessionKey: "agent:main:cron:job:run:session" };
const sessionNode = {
  execHost: "node",
  execNode: "session-node",
  execCwd: "/remote/session/workspace",
} satisfies NonNullable<SessionPlacementTurnParams["execSession"]>;

vi.mock("../../agents/tools/gateway.js", () => ({
  callGatewayTool: gatewayMocks.callGatewayTool,
}));

function turn(overrides: TurnOverrides = {}): SessionPlacementTurnParams {
  return {
    ...placement,
    ...modelRef,
    sessionId: "session-worker-authority",
    sessionFile: "/tmp/session.jsonl",
    workspaceDir: "/tmp/workspace",
    prompt: "run",
    timeoutMs: 1_000,
    runId: "run-worker-authority",
    ...overrides,
  } as SessionPlacementTurnParams;
}

function resolvedAuthority(
  overrides: TurnOverrides = {},
  computerAvailable = false,
  assertCurrent = () => {},
) {
  return resolveWorkerToolAuthority({
    modelRef,
    turn: turn(overrides),
    computerAvailable,
    placement,
    assertCurrent,
  });
}

async function authority(overrides: TurnOverrides = {}, computerAvailable = false) {
  const input = turn(overrides);
  const resolved = await resolvedAuthority(input, computerAvailable);
  const { policy, capabilityProfile, exec, execUnavailable } = resolved;
  const tools: AnyAgentTool[] = createWorkerPlacementTools({
    ...placement,
    policy,
    cwd: input.workspaceDir,
    containmentRoot: input.workspaceDir,
    execAuthority: execUnavailable ? undefined : exec,
    permissionMode: input.permissionMode,
    sessionId: input.sessionId,
    runId: input.runId,
  });
  if (computerAvailable) {
    tools.push({
      name: "computer",
      label: "Computer",
      description: "Synthetic prepared desktop",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ content: [], details: {} }),
    });
  }
  const codingTools = createOpenClawCodingToolsInternal(
    {
      ...input,
      cronCreatorAuthorityUnavailableReason: undefined,
      conversationCapabilityProfile: capabilityProfile,
      wrapBeforeToolCallHook: false,
      toolConstructionPlan: {
        includeBaseCodingTools: false,
        includeShellTools: false,
        includeChannelTools: false,
        includeOpenClawTools: false,
        includePluginTools: false,
      },
    },
    undefined,
    undefined,
    { tools, policy },
  );
  return applyEmbeddedAttemptToolsAllow(codingTools, input.toolsAllow).map((tool) => tool.name);
}

afterEach(() => {
  gatewayMocks.callGatewayTool.mockReset();
  vi.restoreAllMocks();
});

describe("resolveWorkerToolAuthority", () => {
  it("refuses an existing delegated session before exporting worker tool authority", async () => {
    const sessionKey = "agent:main:dashboard:delegated";
    const config = {
      agents: {
        entries: {
          intake: { subagents: { allowAgents: ["main"], delegateToolsTo: ["main"] } },
          main: {},
        },
      },
    };
    const profile = conversationPolicy.resolveConversationCapabilityProfile({
      config,
      agentId: "main",
      sessionKey,
      preparedSessionCapabilityStore: {
        [sessionKey]: {
          sessionId: "delegated",
          spawnedBy: "agent:intake:main",
          spawnDepth: 1,
          inheritedToolPolicyVersion: 1,
          inheritedToolDeny: ["exec"],
          delegatedToolPolicy: {
            requesterSessionKey: "agent:intake:main",
            targetAgentId: "main",
            deny: [],
            requesterDeny: ["exec"],
          },
        },
      },
    });
    expect(profile.policy.delegatedToolPolicy).toBeDefined();
    vi.spyOn(conversationPolicy, "prepareConversationCapabilityProfile").mockResolvedValue(profile);
    await expect(resolvedAuthority({ config, sessionKey })).rejects.toThrow(
      "Worker execution cannot enforce a delegated tool grant",
    );
  });
  it("retains installed skill discovery and read authority across placement", async () => {
    const skill = {
      ...createFixtureSkillEntry("deployment-guide").skill,
      readContent: "# Deployment guide\nUse the canary, then verify the rollback target.\n",
    };
    let current = true;
    const resolved = await resolvedAuthority(
      {
        skillsSnapshot: { prompt: "", skills: [{ name: skill.name }], discoverySkills: [skill] },
      },
      false,
      () => {
        if (!current) {
          throw new Error("worker skill source authority closed");
        }
      },
    );
    expect(resolved.presentation.skills).toEqual([
      { name: skill.name, description: skill.description, location: skill.filePath },
    ]);
    const tools = createInstalledSkillTools(resolved.installedSkills);
    finalizeAgentToolAvailability(tools);
    const search = tools.find((tool) => tool.name === "skills_search")!;
    const read = tools.find((tool) => tool.name === "skills_read")!;
    expect((await search.execute("search", { query: "canary" })).details).toMatchObject({
      skills: [{ name: skill.name }],
    });
    expect((await read.execute("read", { name: skill.name })).details).toEqual({
      name: skill.name,
      location: skill.filePath,
      content: skill.readContent,
    });
    current = false;
    await expect(read.execute("read-closed", { name: skill.name })).rejects.toThrow(
      "source authority closed",
    );
    await expect(search.execute("search-closed", { query: "canary" })).rejects.toThrow(
      "source authority closed",
    );
  });

  it("dispatches discovered skills from the worker RPC context with the admitted transcript", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const target = {
        ...placement,
        sessionId: "recovered-worker-tool-context",
        storePath: resolveOpenClawAgentSqlitePath({ agentId: placement.agentId, env: state.env }),
        expectedLifecycleRevision: "retained-session",
        expectedWriterRunId: "recovered-turn",
      };
      await upsertSessionEntryCore(target, {
        sessionId: target.sessionId,
        lifecycleRevision: target.expectedLifecycleRevision,
        activeWriterRunId: target.expectedWriterRunId,
        updatedAt: 1,
      });
      // Incoming worker messages belong to the connection, not the launching turn's ALS.
      const incoming = new AsyncResource("recovered-worker-tool-rpc");
      const identity = createTranscriptCommitIdentity(target.sessionId, 2);
      let runCurrent = true;
      const assertRunCurrent = () => {
        if (!runCurrent) {
          throw new Error("Worker run closed");
        }
      };
      let retainedContext: (() => void) | undefined;
      try {
        await withWorkerTurnTranscriptDatabase(
          { ...target, sessionTarget: target },
          {
            assertCurrent: assertRunCurrent,
            prepareAuthority: async () => ({ isCurrent: () => runCurrent, release() {} }),
          },
          async (pinned) => {
            const { assertContextCurrent } = captureWorkerTurnInputAuthority({
              transcriptTarget: pinned,
              recorder: undefined,
              assertRunCurrent,
              isBlocked: () => false,
            });
            retainedContext = assertContextCurrent;
            const wrongSession = captureWorkerTurnInputAuthority({
              transcriptTarget: { ...pinned, sessionId: "foreign-session" },
              recorder: undefined,
              assertRunCurrent,
              isBlocked: () => false,
            });
            expect(() => incoming.runInAsyncScope(wrongSession.assertContextCurrent)).toThrow(
              "transcript identity is no longer current",
            );
            const skill = {
              ...createFixtureSkillEntry("recovery-guide").skill,
              readContent: "# Recovery guide\nVerify the canary after recovery.\n",
            };
            const resolved = await resolvedAuthority(
              {
                skillsSnapshot: {
                  prompt: "",
                  skills: [{ name: skill.name }],
                  discoverySkills: [skill],
                },
              },
              false,
              assertContextCurrent,
            );
            const tools = createInstalledSkillTools(resolved.installedSkills);
            finalizeAgentToolAvailability(tools);
            for (const tool of tools) {
              bindAgentToolExecutionLocation(tool, { kind: "gateway" });
            }
            const controller = new AbortController();
            const runtime = createWorkerGatewayToolRuntime({
              assertCurrent: assertRunCurrent,
              signal: controller.signal,
              prepare: async () => ({
                tools,
                policy: resolved.policy,
                presentation: resolved.presentation,
              }),
            });
            const harness = createAgentHarnessToolSurfaceRuntimeCore({
              modelToolsEnabled: true,
              supportsDeferredToolCalls: false,
              config: { tools: { codeMode: false, toolSearch: { enabled: true, mode: "tools" } } },
            });
            try {
              const surface = await runtime.getSurface(identity);
              const proxies = createWorkerGatewayToolProxies(surface, {
                invokeGatewayTool: async (request) => ({
                  type: "res",
                  id: request.toolCallId,
                  ok: true,
                  payload: await incoming.runInAsyncScope(() =>
                    runtime.invoke(identity, request, { send() {} }),
                  ),
                }),
                cancelGatewayTool: async (request) => ({
                  type: "res",
                  id: request.toolCallId,
                  ok: true,
                  payload: runtime.cancel(request),
                }),
              });
              const modelTools = harness
                .compactTools(proxies, { prepared: { preserveToolNames: [] } })
                .promptToolPolicy.apply().tools;
              const search = modelTools.find((tool) => tool.name === "tool_search")!;
              const dispatch = modelTools.find((tool) => tool.name === "dispatch_action")!;
              const discovered = await search.execute("discover", { query: "skills_search" });
              expect(JSON.stringify(discovered)).toContain("openclaw:core:skills_search");
              const invoke = (id: string) =>
                dispatch.execute(id, {
                  id: "openclaw:core:skills_search",
                  args: { query: "canary" },
                });
              expect((await invoke("recovered-skill-search")).details).toMatchObject({
                result: { details: { skills: [{ name: skill.name }] } },
              });
              await patchSessionEntryCore(target, () => ({
                activeWriterRunId: "replacement-writer",
              }));
              expect((await invoke("stale-skill-search")).details).toMatchObject({
                result: {
                  details: {
                    status: "error",
                    error: expect.stringContaining("transcript identity is no longer current"),
                  },
                },
              });
              runCurrent = false;
              await expect(invoke("closed-skill-search")).rejects.toThrow("Worker run closed");
              runCurrent = true;
            } finally {
              await runtime.close();
              harness.cleanup();
            }
          },
        );
        expect(retainedContext).toBeDefined();
        expect(retainedContext).toThrow("Cloud worker transcript authority has been released");
      } finally {
        incoming.emitDestroy();
      }
    });
  });

  it.each([
    ["default", {}, true, null],
    ["additive sandbox tools", { sandbox: { tools: { alsoAllow: ["web_fetch"] } } }, true, null],
    ["explicit sandbox allow", { sandbox: { tools: { allow: ["read"] } } }, false, ["read"]],
    ["explicit sandbox deny", { sandbox: { tools: { deny: ["computer"] } } }, false, null],
    ["global deny", { deny: ["computer"] }, false, null],
    ["coding profile", { profile: "coding" }, false, null],
  ] satisfies Array<
    [string, NonNullable<SessionPlacementTurnParams["config"]>["tools"], boolean, string[] | null]
  >)(
    "respects %s policy for a prepared sandbox-contained desktop",
    async (_name, tools, allowed, expected) => {
      const overrides = {
        sessionKey: "agent:main:worker-sandboxed",
        config: { agents: { defaults: { sandbox: { mode: "all" as const } } }, tools },
      };
      const unprepared = await authority(overrides);
      expect(unprepared).not.toContain("computer");
      expect((await authority(overrides, true)).includes("computer")).toBe(allowed);
      if (expected) {
        expect(unprepared).toEqual(expected);
      }
    },
  );

  it.each(["sandbox", "node"] as const)(
    "withholds exec and process when the captured host is %s",
    async (host) => {
      expect(
        await resolvedAuthority({
          config: { tools: { exec: { host, mode: "full" } } },
          toolsAllow: ["exec", "process"],
        }),
      ).toMatchObject({
        exec: { host, security: "full", ask: "off" },
      });
      const tools = await authority({ config: { tools: { exec: { host, mode: "full" } } } });
      expect(tools.filter((name) => name === "exec" || name === "process")).toEqual([]);
    },
  );

  it.each([
    ["deny", { security: "deny", ask: "off" }],
    ["allowlist", { mode: "allowlist" }],
  ] as const)("preserves effective exec authority for configured %s", async (security, exec) => {
    expect(
      await resolvedAuthority({ config: { tools: { exec } }, toolsAllow: ["exec", "process"] }),
    ).toMatchObject({ exec: { security, ask: "off" } });
  });

  it.each([
    ["deny", { permissionMode: "read-only" }, { security: "deny", ask: "off" }],
    ["approval", { permissionMode: "guarded" }, { security: "allowlist", ask: "on-miss" }],
    [
      "node binding",
      { ...sessionNode, execCwd: " /remote/session/workspace " },
      { host: "node", node: "session-node", security: "full", ask: "off" },
    ],
  ] as const)(
    "preserves effective exec authority for session %s",
    async (_name, execSession, expected) => {
      const { exec } = await resolvedAuthority({
        config: { tools: { exec: { host: "gateway", mode: "full" } } },
        toolsAllow: ["exec", "process"],
        execSession,
      });
      expect(exec).toEqual({ host: "gateway", safeBins: [], ...expected });
    },
  );

  it.each([
    ["node binding differs", { host: "node", node: "other-node" }, "node"],
    ["host is not node", { host: "gateway" }, "gateway"],
  ] as const)("omits the session node cwd when %s", async (_name, execOverrides, expectedHost) => {
    const { exec } = await resolvedAuthority({ execSession: sessionNode, execOverrides });
    expect(exec?.host).toBe(expectedHost);
    expect(exec).not.toHaveProperty("nodeCwd");
  });

  it("keeps the resolved node binding authoritative when a worker request names another node", async () => {
    gatewayMocks.callGatewayTool.mockResolvedValue({
      nodes: [{ nodeId: "bound-node" }, { nodeId: "other-node" }],
    });
    const resolved = await resolvedAuthority({
      config: { tools: { exec: { host: "node", mode: "full", node: "bound-node" } } },
      toolsAllow: ["exec", "process"],
    });
    expect(resolved.exec).toMatchObject({ host: "node", node: "bound-node" });
    assert(resolved.exec?.host === "node");
    await expect(
      resolveNodeExecutionTarget({
        command: "echo worker-node-binding",
        workdir: undefined,
        env: {},
        requestedNode: "other-node",
        boundNode: resolved.exec.node,
        security: "full",
        ask: "off",
        defaultTimeoutSec: 30,
        approvalRunningNoticeMs: 0,
        warnings: [],
      }),
    ).rejects.toThrow(
      "exec node not allowed (bound to bound-node, requested resolved to other-node)",
    );
  });

  it("projects runtime caps with canonical write-to-apply_patch semantics", async () => {
    expect(await authority({ toolsAllow: ["write"] })).toEqual(["write", "apply_patch"]);
    expect(await authority({ toolsAllow: [] })).toEqual([]);
  });

  it.each([
    { senderId: "restricted", expected: ["read"] },
    { senderId: "authorized", expected: ["read", "write", "apply_patch"] },
  ])(
    "projects destination policy for original requester $senderId",
    async ({ senderId, expected }) => {
      expect(
        await authority({
          senderId: "worker-route-sender",
          senderIsOwner: true,
          toolsAllow: ["read", "write"],
          config: {
            agents: {
              entries: {
                research: { tools: { deny: ["write", "apply_patch"] } },
                main: {
                  tools: { toolsBySender: { "id:restricted": { deny: ["write", "apply_patch"] } } },
                },
              },
            },
          },
          requesterOrigin: {
            sessionKey: "agent:research:whatsapp:group:requesters",
            messageProvider: "whatsapp",
            senderId,
          },
        }),
      ).toEqual(expected);
    },
  );

  it("applies current owner policy and the appropriate sender overlays", async () => {
    const denyWrites = { deny: ["write", "apply_patch"] };
    const toolsAllow = ["read", "write", "exec"];
    const toolsBySender = { "*": denyWrites };
    const config: NonNullable<SessionPlacementTurnParams["config"]> = {
      tools: { deny: ["exec"], toolsBySender },
      channels: {
        whatsapp: {
          groups: { team: { tools: { allow: toolsAllow }, toolsBySender } },
        },
      },
    };
    const scheduledToolPolicy: NonNullable<SessionPlacementTurnParams["scheduledToolPolicy"]> = {
      version: 1,
      mode: "account",
      ownerSessionKey: "agent:main:whatsapp:group:team",
      ownerAccountId: "default",
    };
    const sender = { messageProvider: "whatsapp", config, senderId: "guest", toolsAllow };
    expect(await authority({ ...sender, scheduledToolPolicy })).toEqual([
      "read",
      "write",
      "apply_patch",
    ]);
    expect(await authority(sender)).toEqual(["read"]);
    expect(
      await authority({
        messageProvider: "whatsapp",
        config: { channels: { whatsapp: { groups: { team: { tools: denyWrites } } } } },
        toolsAllow: ["write"],
        scheduledToolPolicy,
      }),
    ).toEqual([]);
  });
});
