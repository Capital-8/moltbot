import { AgentHarnessSessionSupersededError } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  prepareNativeSessionGenerationAuthority,
  type NativeSessionGenerationOperationsV2,
} from "openclaw/plugin-sdk/agent-harness-session-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { CodexAppServerBindingIdentity } from "./session-binding-record.js";
import type { CodexAppServerBindingStore } from "./session-binding.js";

/** Decides whether a run may share the durable stable-key binding owner. */
export async function resolveCodexRunSessionBindingAuthority(params: {
  identity: Extract<CodexAppServerBindingIdentity, { kind: "session" }>;
  config?: OpenClawConfig;
  storePath?: string;
}): Promise<Awaited<ReturnType<typeof prepareNativeSessionGenerationAuthority>>["state"]> {
  return (
    await prepareNativeSessionGenerationAuthority({
      ...params,
      target: params.identity,
      createSupersededError: createCodexSessionGenerationSupersededError,
    })
  ).state;
}

/** Builds the terminal coordination error used when a newer OpenClaw session owns the binding. */
export function createCodexSessionGenerationSupersededError(
  sessionId: string,
): AgentHarnessSessionSupersededError {
  return new AgentHarnessSessionSupersededError(
    `Codex session generation is no longer current: ${sessionId}`,
  );
}

export function codexSessionGenerationOperations(
  store: CodexAppServerBindingStore,
  identity: Extract<CodexAppServerBindingIdentity, { kind: "session" }>,
): NativeSessionGenerationOperationsV2 {
  return {
    prepareReclaim: () => store.prepareSessionGenerationReclaim(identity),
    adopt: (expectedPreviousSessionId, authority) =>
      store.adoptSessionGeneration(
        identity,
        expectedPreviousSessionId,
        authority.assertCurrent,
        authority,
      ),
    reclaim: (expectedPreviousSessionId, authority) =>
      store.mutate(
        identity,
        { kind: "reclaim-generation", expectedPreviousSessionId },
        authority.assertCurrent,
        authority,
      ),
  };
}
