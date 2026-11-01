import { wrapPromptDataBlock } from "openclaw/plugin-sdk/qa-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { extractGatewayMessageText } from "./gateway-log-sentinel.js";

/**
 * Public history hides the completion input, but preserves the reply's transcript entry ID.
 * Join that reply to a yielded requester's settlement in the same transcript branch.
 * A direct announcement can keep its result in private runtime context; it is not this proof.
 */
export async function findSubagentHandoffReply(
  visibleMessages: readonly unknown[],
  childSessionKey: string,
  childReply: string,
  readRequesterTranscript: () => Promise<readonly unknown[]>,
): Promise<string | undefined> {
  const visible = new Map<string, string>();
  // Compare forward through the producer's framing, never decode or accept a truncation.
  const resultBlock = wrapPromptDataBlock({
    label: "Child result",
    text: childReply,
    encoding: "verbatim",
  });
  if (!resultBlock) {
    return undefined;
  }
  const expected = resultBlock.split("\n").slice(2, -1).join("\n");
  for (const message of visibleMessages) {
    if (!isRecord(message) || message.role !== "assistant" || message.phase === "commentary") {
      continue;
    }
    const meta = message["__openclaw"];
    if (!isRecord(meta)) {
      continue;
    }
    const identities = [
      typeof meta.id === "string" && meta.id ? `id:${meta.id}` : undefined,
      typeof meta.runId === "string" && meta.runId ? `run:${meta.runId}` : undefined,
    ].filter((value): value is string => Boolean(value));
    if (identities.length === 0) {
      continue;
    }
    const text = extractGatewayMessageText(message);
    // Consume the known result before looking for Evidence: it can contain that very label.
    // The mock provider puts the verbatim result in a Markdown list.
    const label = /^Delegated task:[\s\S]*?^Result:[ \t]*(?:\r?\n)?/im.exec(text);
    const result = label && text.slice(label.index + label[0].length).trimStart();
    if (
      result &&
      [expected, `- ${expected}`].some(
        (value) =>
          result.startsWith(value) && /^[ \t]*\r?\n\s*Evidence:/i.test(result.slice(value.length)),
      )
    ) {
      for (const identity of identities) {
        visible.set(identity, text);
      }
    }
  }
  if (visible.size === 0) {
    return undefined;
  }

  const afterDelivery = new Set<string>();
  for (const event of await readRequesterTranscript()) {
    if (
      !isRecord(event) ||
      event.type !== "message" ||
      typeof event.id !== "string" ||
      !isRecord(event.message)
    ) {
      continue;
    }
    const { id, parentId, message } = event;
    if (message.role === "user") {
      const p = message.provenance;
      if (
        isRecord(p) &&
        p.kind === "inter_session" &&
        p.sourceChannel === "internal" &&
        p.sourceSessionKey === childSessionKey &&
        p.sourceTool === "subagent_settle"
      ) {
        // buildChildCompletionFindings frames the result separately from the task.
        // This scenario has one child; another result in the wake is ambiguous.
        const [result, another] = extractGatewayMessageText(message).matchAll(
          /^status: ([^\n]+)\n(Child result [^\n]*\n<prompt-data>\n[\s\S]*?\n<\/prompt-data>)$/gm,
        );
        if (!another && result?.[1] === "ok" && result[2] === resultBlock) {
          afterDelivery.add(id);
        }
      }
    } else if (typeof parentId === "string" && afterDelivery.has(parentId)) {
      const meta = isRecord(message["__openclaw"]) ? message["__openclaw"] : undefined;
      const reply =
        visible.get(`id:${id}`) ??
        (typeof meta?.runId === "string" ? visible.get(`run:${meta.runId}`) : undefined);
      if (reply && message.role === "assistant" && extractGatewayMessageText(message) === reply) {
        return reply;
      }
      afterDelivery.add(id);
    }
  }
  return undefined;
}
