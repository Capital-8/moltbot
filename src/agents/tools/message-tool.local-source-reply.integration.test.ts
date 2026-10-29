// Only the channel adapter and capture consumer are synthetic. Tool execution,
// source matching, transcript writes, accepted-turn publication and history reads are real.
import path from "node:path";
import { afterEach, expect, it, vi, type Mock } from "vitest";
import type { SourceReplyDeliveryMode } from "../../auto-reply/get-reply-options.types.js";
import type { FinalizedMsgContext } from "../../auto-reply/templating.js";
import { mergeSessionTranscriptContext } from "../../channels/inbound-event/session-transcript-context.runtime.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import {
  readTranscriptEventId,
  readTranscriptEventMessage,
} from "../../config/sessions/session-accessor.sqlite-read.js";
import { readActiveTranscriptEntryAnchorAsync } from "../../config/sessions/session-transcript-anchor-read.js";
import { readRecentUserAssistantTurnsForSession } from "../../config/sessions/transcript.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  mintMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../../gateway/message-action-turn-capability.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import { persistUserTurnTranscript } from "../../sessions/user-turn-transcript.persistence.js";
import { createChannelTestPluginBase } from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  drainPendingContextEngineTurnsBeforeRun,
  finalizeAcceptedContextEngineTurn,
} from "../harness/context-engine-turn-attempt.js";
import {
  createCommitTurn,
  createTurnEngine,
  createTurnLease,
} from "../harness/context-engine-turn.test-support.js";
import { jsonResult } from "./common.js";
import { createMessageTool } from "./message-tool-execution.js";
import {
  registerMessageChannel,
  stubMessageSecrets,
} from "./message-tool-execution.test-support.js";

const sessionKey = "agent:main:discord:channel:12345";
const sessionId = "local-source-session";
const runId = "local-source-run";
const sourceTurnId = "local-source-turn";
const request = { sender: "User", messageId: "request-60", body: 'reply only "60"' };

function historyContext(): FinalizedMsgContext {
  return {
    Body: 'reply only "61"',
    CommandAuthorized: false,
    SessionTranscriptContext: { historyLimit: 10, historyKind: "recent" },
    InboundHistory: [request],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
  resetPluginRuntimeStateForTest();
});

async function withLocalSource(
  mode: SourceReplyDeliveryMode,
  run: (fixture: {
    tool: ReturnType<typeof createMessageTool>;
    scope: { agentId: string; sessionKey: string; sessionId: string; storePath: string };
    handleAction: Mock<() => Promise<ReturnType<typeof jsonResult>>>;
    capture: () => Promise<ReturnType<typeof createCommitTurn>>;
  }) => Promise<void>,
) {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "local-source-reply-" },
    async (state) => {
      const storePath = path.join(state.sessionsDir(), "sessions.json");
      const scope = { agentId: "main", sessionKey, sessionId, storePath };
      const sessionEntry = { sessionId, updatedAt: 1, chatType: "channel" as const };
      const config: OpenClawConfig = {
        agents: { entries: { main: {} }, defaults: { workspace: state.workspaceDir } },
        session: { store: storePath },
        channels: { discord: { enabled: true } },
      };
      setRuntimeConfigSnapshot(config);
      stubMessageSecrets();
      const handleAction = vi.fn(async () =>
        jsonResult({ ok: true, messageId: "answer-60", channelId: "12345" }),
      );
      registerMessageChannel({
        ...createChannelTestPluginBase({
          id: "discord",
          capabilities: { chatTypes: ["channel"] },
          config: { resolveAccount: () => ({ enabled: true }), isConfigured: () => true },
        }),
        actions: {
          describeMessageTool: () => ({ actions: ["send"] }),
          supportsAction: ({ action }) => action === "send",
          resolveExecutionMode: () => "local",
          handleAction,
        },
        messaging: {
          normalizeTarget: (target) => target.replace(/^channel:/, ""),
          targetResolver: {
            looksLikeId: (target) => /^(?:channel:)?[0-9]+$/.test(target),
            hint: "<channel id>",
          },
        },
        outbound: {
          deliveryMode: "direct",
          sendText: async () => {
            throw new Error("unexpected core send");
          },
        },
      } satisfies ChannelPlugin);
      await replaceSessionEntry(scope, sessionEntry);
      const input = await persistUserTurnTranscript({
        ...scope,
        sessionEntry,
        logicalTurnId: sourceTurnId,
        input: {
          text: request.body,
          timestamp: 1,
          transport: { channel: "discord", messageId: request.messageId },
        },
      });
      if (!input?.admission) {
        throw new Error("missing real user admission");
      }
      const commitTurn = createCommitTurn();
      const lease = createTurnLease(createTurnEngine(commitTurn));
      const warn = vi.fn();
      await drainPendingContextEngineTurnsBeforeRun({ admission: input.admission, lease, warn });
      const source = {
        currentChannelProvider: "discord",
        currentChannelId: "12345",
        currentMessagingTarget: "12345",
        currentChatType: "channel" as const,
        currentMessageId: request.messageId,
        currentSourceTurnId: sourceTurnId,
      };
      const capability = mintMessageActionTurnCapability({
        agentId: "main",
        sessionKey,
        runId,
        requesterAccountId: "default",
        toolContext: source,
      });
      try {
        await run({
          scope,
          handleAction,
          tool: createMessageTool({
            config,
            ...source,
            agentId: "main",
            agentSessionKey: sessionKey,
            runSessionKey: sessionKey,
            sessionId,
            runId,
            agentAccountId: "default",
            messageActionTurnCapability: capability,
            sourceReplyDeliveryMode: mode,
          }),
          capture: async () => {
            const events = await loadTranscriptEvents(scope);
            const terminalId = readTranscriptEventId(events.at(-1));
            const terminal =
              terminalId &&
              (await readActiveTranscriptEntryAnchorAsync({ ...scope, entryId: terminalId }));
            if (!terminal) {
              throw new Error("missing persisted terminal anchor");
            }
            await finalizeAcceptedContextEngineTurn({
              config,
              lease,
              warn,
              facts: {
                boundary: { admission: input.admission, terminal },
                sessionIdUsed: sessionId,
                sessionKey,
                promptError: false,
                aborted: false,
                yieldAborted: false,
              },
            });
            expect(warn).not.toHaveBeenCalled();
            return commitTurn;
          },
        });
      } finally {
        revokeMessageActionTurnCapability(capability);
      }
    },
  );
}

it.each(["automatic", "message_tool_only"] as const)(
  "persists and captures a local final source answer once in %s mode",
  async (mode) => {
    await withLocalSource(mode, async ({ tool, scope, handleAction, capture }) => {
      for (let replay = 0; replay < 2; replay++) {
        const result = await tool.execute("send-60", {
          action: "send",
          message: "60",
          final: true,
        });
        expect(result.details).toMatchObject({
          messageDelivery: {
            status: "settled",
            partialDelivery: false,
            sourceReplyDelivered: true,
          },
        });
      }
      expect(handleAction).toHaveBeenCalledTimes(2);
      const messages = (await loadTranscriptEvents(scope)).map(readTranscriptEventMessage);
      const answers = messages.filter((message) => message?.role === "assistant");
      expect(answers).toHaveLength(1);
      expect(answers[0]).toMatchObject({
        content: [{ type: "text", text: "60" }],
        openclawDeliveryMirror: {
          kind: "message-tool-source-reply",
          final: true,
          sourceTurnId,
          toolCallId: "send-60",
        },
      });
      const commitTurn = await capture();
      expect(commitTurn).toHaveBeenCalledOnce();
      expect(commitTurn.mock.calls[0]?.[0].messages).toMatchObject([
        { role: "user", content: request.body },
        {
          role: "assistant",
          content: [{ type: "text", text: "60" }],
          openclawDeliveryMirror: { final: true },
        },
      ]);
      expect(
        await readRecentUserAssistantTurnsForSession({
          ...scope,
          includeMessageToolSourceReplies: true,
        }),
      ).toMatchObject([
        { role: "user", text: request.body, messageId: request.messageId },
        { role: "assistant", text: "60", isCompletedAnswer: true },
      ]);
      const ctx = historyContext();
      await mergeSessionTranscriptContext({ ...scope, ctx });
      expect(ctx.InboundHistory).toEqual([]);
    });
  },
);

it.each([
  {
    name: "progress",
    args: { final: false },
    receipt: { ok: true, messageId: "progress", channelId: "12345" },
    stored: 1,
  },
  {
    name: "dry run",
    args: { dryRun: true },
    receipt: { ok: true, messageId: "unused" },
    stored: 0,
  },
  { name: "failed send", receipt: { ok: false, messageId: "attempt" }, stored: 0 },
  {
    name: "partial send",
    receipt: { ok: false, sentBeforeError: true, messageId: "part" },
    stored: 0,
  },
  { name: "suppressed send", receipt: { status: "suppressed" }, stored: 0 },
  {
    name: "different recipient",
    receipt: { ok: true, messageId: "elsewhere", channelId: "99999" },
    stored: 0,
  },
])("does not complete the stored source turn for $name", async ({ args, receipt, stored }) => {
  await withLocalSource("automatic", async ({ tool, scope, handleAction }) => {
    handleAction.mockResolvedValue(jsonResult(receipt));
    await tool.execute("not-final", { action: "send", message: "60", final: true, ...args });
    const answers = (await loadTranscriptEvents(scope))
      .map(readTranscriptEventMessage)
      .filter((message) => message?.role === "assistant");
    expect(answers).toHaveLength(stored);
    if (stored) {
      expect(answers[0]).toMatchObject({ openclawDeliveryMirror: { final: false } });
    }
    const ctx = historyContext();
    await mergeSessionTranscriptContext({ ...scope, ctx });
    expect(ctx.InboundHistory).toEqual([request]);
  });
});
