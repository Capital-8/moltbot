import { normalizeAgentIdStrict } from "@openclaw/normalization-core/agent-id";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { CHAT_SEND_SESSION_KEY_MAX_LENGTH } from "../../packages/gateway-protocol/src/schema/primitives.js";
import {
  CONTROL_UI_SESSION_PULL_REQUESTS_MAX_KEYS,
  sessionPullRequestSelectionKey as selectionKey,
  type ControlUiSessionPullRequestSelection as Selection,
} from "./control-ui-contract.js";

function parseSessionKeys(value: unknown): Selection[] | null {
  if (!Array.isArray(value) || value.length > CONTROL_UI_SESSION_PULL_REQUESTS_MAX_KEYS) {
    return null;
  }
  const keys = new Map<string, Selection>();
  for (const entry of value) {
    const target = asNullableRecord(entry);
    const key =
      typeof entry === "string"
        ? entry.trim()
        : typeof target?.sessionKey === "string"
          ? target.sessionKey.trim()
          : "";
    if (!key || key.length > CHAT_SEND_SESSION_KEY_MAX_LENGTH) {
      return null;
    }
    let selection: Selection = key;
    if (typeof entry !== "string") {
      if (
        !target ||
        Object.keys(target).some((field) => field !== "sessionKey" && field !== "agentId") ||
        typeof target.agentId !== "string"
      ) {
        return null;
      }
      const agent = normalizeAgentIdStrict(target.agentId);
      if (!agent.ok) {
        return null;
      }
      selection = { sessionKey: key, agentId: agent.value };
    }
    keys.set(selectionKey(selection), selection);
  }
  return [...keys.values()];
}

export function parseControlUiSessionPullRequestsSubscribeParams(value: unknown): {
  sessionKeys: Selection[];
  refreshSessionKeys: Selection[];
  passiveSessionKeys?: Selection[];
} | null {
  const raw = asNullableRecord(value);
  if (!raw) {
    return null;
  }
  const sessionKeys = parseSessionKeys(raw.sessionKeys);
  const refreshSessionKeys =
    raw.refreshSessionKeys === undefined ? [] : parseSessionKeys(raw.refreshSessionKeys);
  const passiveSessionKeys =
    raw.passiveSessionKeys === undefined ? [] : parseSessionKeys(raw.passiveSessionKeys);
  if (!sessionKeys || !refreshSessionKeys || !passiveSessionKeys) {
    return null;
  }
  const watched = new Set(sessionKeys.map(selectionKey));
  for (const key of refreshSessionKeys) {
    if (!watched.has(selectionKey(key))) {
      return null;
    }
  }
  const passive = passiveSessionKeys.filter((key) => !watched.has(selectionKey(key)));
  if (
    new Set([...sessionKeys, ...passive].map(selectionKey)).size >
    CONTROL_UI_SESSION_PULL_REQUESTS_MAX_KEYS
  ) {
    return null;
  }
  return {
    sessionKeys,
    refreshSessionKeys,
    ...(passive.length ? { passiveSessionKeys: passive } : {}),
  };
}
