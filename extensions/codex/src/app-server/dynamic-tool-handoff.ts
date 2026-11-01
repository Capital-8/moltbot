import { createHash } from "node:crypto";
import { z } from "zod";
import type { CodexAppServerRuntimeOptions } from "./config-contracts.js";
import type {
  CodexDynamicToolCallParams,
  CodexDynamicToolCallResponse,
  JsonObject,
} from "./protocol.js";
import type { CodexAppServerThreadBinding } from "./session-binding.js";

export const CODEX_DYNAMIC_TOOL_HANDOFF_MAX_CALLS = 128;
export const CODEX_DYNAMIC_TOOL_HANDOFF_MAX_BYTES = 256 * 1024;
const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
const identitySchema = {
  callId: z.string().min(1),
  requestId: z.union([z.string(), z.number().int()]),
  requestFingerprint: fingerprintSchema,
};
const responseSchema = z
  .object({
    success: z.boolean(),
    contentItems: z.tuple([z.object({ type: z.literal("inputText"), text: z.string() }).strict()]),
  })
  .strict();
const callSchema = z.discriminatedUnion("state", [
  z.object({ ...identitySchema, state: z.literal("started") }).strict(),
  z.object({ ...identitySchema, state: z.literal("unsupported") }).strict(),
  z.object({ ...identitySchema, state: z.literal("completed"), response: responseSchema }).strict(),
]);
const recordSchema = z
  .object({
    version: z.literal(1),
    coverage: z.literal("all-dynamic-tools"),
    turnId: z.string().min(1),
    sourceRunId: z.string().min(1),
    admissionFingerprint: fingerprintSchema,
    unsupported: z.literal(true).optional(),
    calls: z.array(callSchema).max(CODEX_DYNAMIC_TOOL_HANDOFF_MAX_CALLS),
  })
  .strict();
export type CodexDynamicToolHandoff = z.infer<typeof recordSchema>;
export type CodexDynamicToolHandoffCall = z.infer<typeof callSchema>;
export type CodexDynamicToolHandoffResponse = z.infer<typeof responseSchema>;
export type CodexDynamicToolHandoffRequest = {
  requestId: string | number;
  call: CodexDynamicToolCallParams;
};

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}
function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

/** Resolved native policy is not always populated on legacy binding rows. */
export function buildCodexDynamicToolHandoffAdmissionConfig(
  appServer: Pick<
    CodexAppServerRuntimeOptions,
    "approvalPolicy" | "approvalsReviewer" | "sandbox" | "codeModeOnly" | "sessionRoot"
  >,
  nativeHookConfig?: JsonObject,
): JsonObject {
  return {
    nativeHookConfig: nativeHookConfig ?? null,
    policy: {
      approvalPolicy: appServer.approvalPolicy,
      approvalsReviewer: appServer.approvalsReviewer,
      sandbox: appServer.sandbox,
      codeModeOnly: appServer.codeModeOnly,
      sessionRoot: appServer.sessionRoot ?? null,
    },
  };
}

/** Current policy admission still owns authorization; this is exact policy correlation only. */
export function fingerprintCodexDynamicToolHandoffAdmission(
  binding: CodexAppServerThreadBinding,
  nativeHookConfig?: JsonObject,
): string {
  const {
    threadId,
    cwd,
    authProfileId,
    model,
    modelProvider,
    approvalPolicy,
    sandbox,
    networkProxyProfileName,
    networkProxyConfigFingerprint,
    dynamicToolsFingerprint,
    dynamicToolsContainDeferred,
    webSearchThreadConfigFingerprint,
    nativeSkillIsolationFingerprint,
    userMcpServersFingerprint,
    mcpServersFingerprint,
    configuredMcpOwnershipVersion,
    nativeToolPolicyRestricted,
    appServerRuntimeFingerprint,
    pluginAppsFingerprint,
    pluginAppPolicyContext,
    environmentSelectionFingerprint,
  } = binding;
  return hash({
    authorizationDomain: "gateway-exec-unrestricted-v1",
    threadId,
    cwd,
    authProfileId,
    model,
    modelProvider,
    approvalPolicy,
    sandbox,
    networkProxyProfileName,
    networkProxyConfigFingerprint,
    dynamicToolsFingerprint,
    dynamicToolsContainDeferred,
    webSearchThreadConfigFingerprint,
    nativeSkillIsolationFingerprint,
    userMcpServersFingerprint,
    mcpServersFingerprint,
    configuredMcpOwnershipVersion,
    nativeToolPolicyRestricted,
    appServerRuntimeFingerprint,
    pluginAppsFingerprint,
    pluginAppPolicyContext,
    environmentSelectionFingerprint,
    nativeHookRelayGeneration: binding.nativeHookRelayGeneration,
    nativeHookConfig,
  });
}

/** Hash exact native input before presentation sanitization; never persist its arguments. */
export function codexDynamicToolHandoffRequestIdentity({
  requestId,
  call,
}: CodexDynamicToolHandoffRequest) {
  return {
    requestId,
    callId: call.callId,
    requestFingerprint: hash({
      threadId: call.threadId,
      turnId: call.turnId,
      callId: call.callId,
      namespace: call.namespace ?? null,
      tool: call.tool,
      arguments: call.arguments,
    }),
  };
}

export function readCodexDynamicToolHandoffV1(value: unknown): CodexDynamicToolHandoff | undefined {
  const parsed = recordSchema.safeParse(value);
  if (
    !parsed.success ||
    Buffer.byteLength(JSON.stringify(parsed.data)) > CODEX_DYNAMIC_TOOL_HANDOFF_MAX_BYTES
  ) {
    return undefined;
  }
  const calls = parsed.data.calls;
  if (
    new Set(calls.map((call) => call.callId)).size !== calls.length ||
    new Set(calls.map((call) => JSON.stringify(call.requestId))).size !== calls.length
  ) {
    return undefined;
  }
  return parsed.data;
}

export function readCodexDynamicToolHandoffResponse(
  value: CodexDynamicToolCallResponse,
): CodexDynamicToolHandoffResponse | undefined {
  const parsed = responseSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function isCodexDynamicToolHandoffComplete(record: CodexDynamicToolHandoff): boolean {
  return !record.unsupported && record.calls.every((call) => call.state === "completed");
}

/** Per-call lookup after admission; cold rejoin separately requires the whole journal complete.
 * Reads without consuming: a transport write is not a native acknowledgment. */
export function readCompletedCodexDynamicToolHandoffResponse(
  record: CodexDynamicToolHandoff,
  request: CodexDynamicToolHandoffRequest,
): CodexDynamicToolHandoffResponse | undefined {
  if (record.turnId !== request.call.turnId) {
    return undefined;
  }
  const identity = codexDynamicToolHandoffRequestIdentity(request);
  const receipt = record.calls.find((call) => call.callId === identity.callId);
  return receipt?.state === "completed" &&
    receipt.requestId === identity.requestId &&
    receipt.requestFingerprint === identity.requestFingerprint
    ? structuredClone(receipt.response)
    : undefined;
}
