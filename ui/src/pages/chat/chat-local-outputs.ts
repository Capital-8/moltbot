import type { SessionProjectionEntry } from "@openclaw/gateway-client/browser";

export function chatLocalOutputMessages(
  entries: readonly SessionProjectionEntry[] | undefined,
): unknown[] {
  return entries?.filter((entry) => entry.localOutput).map((entry) => entry.message) ?? [];
}

export function withoutChatLocalOutputs<T extends { messages: unknown[] }>(
  snapshot: T,
  localOutputs: readonly unknown[],
): T {
  const excluded = new Set(localOutputs);
  if (!excluded.size || !snapshot.messages.some((message) => excluded.has(message))) {
    return snapshot;
  }
  return { ...snapshot, messages: snapshot.messages.filter((message) => !excluded.has(message)) };
}
