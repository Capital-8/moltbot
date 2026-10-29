import { asOptionalRecord as asPayloadRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { StreamFn } from "../../../agents/runtime/index.js";
import type { ThinkLevel } from "../../../auto-reply/thinking.js";
import { createLazyRuntimeModule } from "../../../shared/lazy-runtime.js";

const loadDefaultStream = createLazyRuntimeModule(() => import("../../stream.js"));

type MoonshotThinkingType = "enabled" | "disabled";
type MoonshotThinkingKeep = "all";
type MoonshotPayloadFinalizer = (result: unknown, payload: Record<string, unknown>) => unknown;
const ALWAYS_THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
const FIXED_SAMPLING_FIELDS = "temperature top_p n presence_penalty frequency_penalty".split(" ");
/** Always-on thinking; `effort` is the fixed reasoning_effort, absent for a plain on switch. */
type MoonshotAlwaysThinking = { effort?: string };
// Published plugins still call this helper with bare models that carry no catalog facts;
// they keep the always-thinking contract these IDs shipped with (`max` is the fixed effort).
const LEGACY_ALWAYS_THINKING: Readonly<Record<string, string | undefined>> = {
  "kimi-k2.7-code": undefined,
  "kimi-k2.7-code-highspeed": undefined,
  "kimi-k3": "max",
  "kimi-k3.1-pro": "max",
  "kimi-k3.1-pro-highspeed": "max",
};
type MoonshotThinkingFacts = {
  id: string;
  thinkingLevelMap?: Partial<Record<string, string | null>>;
  compat?: unknown;
};

function normalizeMoonshotThinkingType(value: unknown): MoonshotThinkingType | undefined {
  const type = asPayloadRecord(value)?.type ?? value;
  if (typeof type === "boolean") {
    return type ? "enabled" : "disabled";
  }
  const normalized = normalizeOptionalLowercaseString(type);
  if (["enabled", "enable", "on", "true"].includes(normalized ?? "")) {
    return "enabled";
  }
  if (["disabled", "disable", "off", "false"].includes(normalized ?? "")) {
    return "disabled";
  }
  return undefined;
}

function isMoonshotToolChoiceCompatible(toolChoice: unknown): boolean {
  const type = asPayloadRecord(toolChoice)?.type ?? toolChoice;
  return type == null || type === "auto" || type === "none";
}

function ensureMoonshotToolCallReasoningContent(payload: Record<string, unknown>): void {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  for (const message of messages) {
    const record = asPayloadRecord(message);
    if (record?.role !== "assistant" || !Array.isArray(record.tool_calls)) {
      continue;
    }
    if (record.tool_calls.length > 0 && !("reasoning_content" in record)) {
      record.reasoning_content = "";
    }
  }
}

// A row that maps `off` to null always thinks; with listed efforts it runs at the highest one.
function resolveAlwaysThinking(
  model: MoonshotThinkingFacts,
  directMoonshotModel: boolean,
): MoonshotAlwaysThinking | undefined {
  let effort: string | undefined;
  // A map that states `off` decides; one that omits it (a partial configured map) keeps the
  // shipped contract for these IDs.
  if (model.thinkingLevelMap && "off" in model.thinkingLevelMap) {
    if (model.thinkingLevelMap.off !== null) {
      return undefined;
    }
    const efforts = asPayloadRecord(model.compat)?.supportedReasoningEfforts;
    const last: unknown = Array.isArray(efforts) ? efforts.at(-1) : undefined;
    // Without effort metadata, the shipped IDs keep their fixed effort.
    const id = model.id.trim().toLowerCase();
    effort =
      typeof last === "string"
        ? last
        : Object.hasOwn(LEGACY_ALWAYS_THINKING, id)
          ? LEGACY_ALWAYS_THINKING[id]
          : undefined;
  } else {
    const id = model.id.trim().toLowerCase();
    if (!Object.hasOwn(LEGACY_ALWAYS_THINKING, id)) {
      return undefined;
    }
    effort = LEGACY_ALWAYS_THINKING[id];
  }
  // A fixed effort is the direct Moonshot API contract; proxies map effort themselves.
  return effort && !directMoonshotModel ? undefined : { effort };
}

function sanitizeAlwaysThinkingPayload(
  payload: Record<string, unknown>,
  { effort }: MoonshotAlwaysThinking,
): void {
  delete payload.thinking;
  delete payload.reasoningEffort;
  FIXED_SAMPLING_FIELDS.forEach((field) => Reflect.deleteProperty(payload, field));
  if (effort) {
    payload.reasoning_effort = effort;
  } else {
    delete payload.reasoning_effort;
    if (!isMoonshotToolChoiceCompatible(payload.tool_choice)) {
      payload.tool_choice = "auto";
    }
  }
}

function prepareThinkingPayload(
  payload: Record<string, unknown>,
  modelId: string,
  alwaysThinking: MoonshotAlwaysThinking | undefined,
  thinkingType?: MoonshotThinkingType,
  thinkingKeep?: MoonshotThinkingKeep,
) {
  const payloadModelId =
    typeof payload.model === "string" ? payload.model.trim().toLowerCase() : modelId;
  let effectiveThinkingType = normalizeMoonshotThinkingType(payload.thinking);
  if (thinkingType) {
    payload.thinking = { type: thinkingType };
    effectiveThinkingType = thinkingType;
  }
  if (alwaysThinking) {
    sanitizeAlwaysThinkingPayload(payload, alwaysThinking);
    return (finalPayload: Record<string, unknown>) => {
      sanitizeAlwaysThinkingPayload(finalPayload, alwaysThinking);
      ensureMoonshotToolCallReasoningContent(finalPayload);
    };
  }
  if (effectiveThinkingType === "enabled" && !isMoonshotToolChoiceCompatible(payload.tool_choice)) {
    const toolChoiceType = asPayloadRecord(payload.tool_choice)?.type;
    if (payload.tool_choice === "required") {
      payload.tool_choice = "auto";
    } else if (toolChoiceType === "tool" || toolChoiceType === "function") {
      payload.thinking = { type: "disabled" };
      effectiveThinkingType = "disabled";
    }
  }
  const thinking = asPayloadRecord(payload.thinking);
  const preserveKeep =
    payloadModelId === "kimi-k2.6" && effectiveThinkingType === "enabled" && thinkingKeep === "all";
  if (thinking) {
    delete thinking.keep;
    Object.assign(thinking, preserveKeep ? { keep: "all" } : {});
  }
  return effectiveThinkingType === "enabled"
    ? ensureMoonshotToolCallReasoningContent
    : () => undefined;
}

/** @deprecated Moonshot provider-owned stream helper; do not use from third-party plugins. */
export function resolveMoonshotThinkingType(params: {
  configuredThinking: unknown;
  thinkingLevel?: ThinkLevel;
}): MoonshotThinkingType | undefined {
  return (
    normalizeMoonshotThinkingType(params.configuredThinking) ??
    (params.thinkingLevel ? (params.thinkingLevel === "off" ? "disabled" : "enabled") : undefined)
  );
}

/** @deprecated Moonshot provider-owned stream helper; do not use from third-party plugins. */
export function resolveMoonshotThinkingKeep(params: {
  configuredThinking: unknown;
}): MoonshotThinkingKeep | undefined {
  const keep = normalizeOptionalLowercaseString(asPayloadRecord(params.configuredThinking)?.keep);
  return keep === "all" ? "all" : undefined;
}

/** @deprecated Moonshot provider-owned stream helper; do not use from third-party plugins. */
export function createMoonshotThinkingWrapper(
  baseStreamFn: StreamFn | undefined,
  thinkingType?: MoonshotThinkingType,
  thinkingKeep?: MoonshotThinkingKeep,
  finalizePayload?: MoonshotPayloadFinalizer,
): StreamFn {
  // Catalog imports need only the policy. Resolve the default transport when a stream starts;
  // an explicitly supplied stream keeps its synchronous invocation contract.
  const underlying: StreamFn =
    baseStreamFn ?? (async (...args) => (await loadDefaultStream()).streamSimple(...args));
  return function moonshotThinkingStream(model, context, options) {
    const modelId = model.id.trim().toLowerCase();
    const directMoonshotModel = normalizeOptionalLowercaseString(model.provider) === "moonshot";
    const alwaysThinking = resolveAlwaysThinking(model, directMoonshotModel);
    const streamModel = alwaysThinking ? { ...model, reasoning: true } : model;
    const streamOptions = alwaysThinking
      ? {
          ...options,
          reasoning: ALWAYS_THINKING_LEVELS.find(
            (level) => level === (alwaysThinking.effort ?? "low"),
          ),
        }
      : options;
    return underlying(streamModel, context, {
      ...streamOptions,
      onPayload(payload, payloadModel) {
        const record = asPayloadRecord(payload);
        if (!record) {
          return streamOptions?.onPayload?.(payload, payloadModel);
        }
        const postThinking = prepareThinkingPayload(
          record,
          modelId,
          alwaysThinking,
          thinkingType,
          thinkingKeep,
        );
        const finish = (result: unknown) => {
          const finalPayload = asPayloadRecord(result) ?? record;
          postThinking(finalPayload);
          return finalizePayload ? finalizePayload(result, finalPayload) : result;
        };
        const result = streamOptions?.onPayload?.(payload, payloadModel);
        return result && typeof (result as Promise<unknown>).then === "function"
          ? Promise.resolve(result).then(finish)
          : finish(result);
      },
    });
  };
}
