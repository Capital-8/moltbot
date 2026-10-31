import { channel } from "node:diagnostics_channel";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";

/** Count wire forms before client reconstruction; retain no payload contents. */
export function sessionPayloadShape(payload: unknown) {
  const source = isRecord(payload) ? payload : {};
  const rowKind = (row: unknown) =>
    !isRecord(row)
      ? "omitted"
      : isRecord(row.full)
        ? "full"
        : typeof row.base === "number" && isRecord(row.set)
          ? "patch"
          : "legacy";
  const session = isRecord(source.session) ? source.session : undefined;
  const ancestors = Array.isArray(source.ancestorSessions) ? source.ancestorSessions : [];
  return {
    fullRows: Number(rowKind(session) === "full"),
    patchRows: Number(rowKind(session) === "patch"),
    legacyRows: Number(rowKind(session) === "legacy"),
    omittedRows: Number(rowKind(session) === "omitted"),
    patchSetFields: session && isRecord(session.set) ? Object.keys(session.set).length : 0,
    patchRemovedFields: session && Array.isArray(session.remove) ? session.remove.length : 0,
    ancestorRows: ancestors.length,
    ancestorFullRows: ancestors.filter((row) => rowKind(row) === "full").length,
    ancestorPatchRows: ancestors.filter((row) => rowKind(row) === "patch").length,
    ancestorLegacyRows: ancestors.filter((row) => rowKind(row) === "legacy").length,
    ancestorReferences: Array.isArray(source.ancestorSessionRefs)
      ? source.ancestorSessionRefs.length
      : 0,
    sessionFieldReferences: Array.isArray(source.sessionFieldRefs)
      ? source.sessionFieldRefs.length
      : 0,
    sidebarRows: Array.isArray(source.sessions) ? source.sessions.length : 0,
    messageBodies: Number(source.message !== undefined),
  };
}

type WireCount = {
  recipient: string;
  event: string;
  frames: number;
  decompressedBytes: number;
  submittedPayloadBytes: number;
  submittedFrameBytes: number;
  unavailableWireFrames: number;
};

/** Separate numeric capture avoids consuming the timing histogram budget. */
export function startSessionWireCapture() {
  const source = channel("openclaw.benchmark.session-wire");
  const groups = new Map<string, WireCount>();
  let droppedFrames = 0;
  const listener = (message: unknown) => {
    if (
      !isRecord(message) ||
      typeof message.recipient !== "string" ||
      message.recipient.length > 128 ||
      typeof message.event !== "string" ||
      message.event.length > 128 ||
      typeof message.bytes !== "number" ||
      !Number.isFinite(message.bytes) ||
      message.bytes < 0
    ) {
      droppedFrames++;
      return;
    }
    const key = JSON.stringify([message.recipient, message.event]);
    let group = groups.get(key);
    if (!group) {
      if (groups.size >= 2048) {
        droppedFrames++;
        return;
      }
      group = {
        recipient: message.recipient,
        event: message.event,
        frames: 0,
        decompressedBytes: 0,
        submittedPayloadBytes: 0,
        submittedFrameBytes: 0,
        unavailableWireFrames: 0,
      };
      groups.set(key, group);
    }
    group.frames++;
    group.decompressedBytes += message.bytes;
    if (
      typeof message.wireBytes === "number" &&
      Number.isFinite(message.wireBytes) &&
      message.wireBytes >= 0
    ) {
      group.submittedPayloadBytes += message.wireBytes;
      // The negotiated codec submits one complete, unmasked server text frame.
      group.submittedFrameBytes +=
        message.wireBytes + (message.wireBytes < 126 ? 2 : message.wireBytes < 65536 ? 4 : 10);
    } else {
      group.unavailableWireFrames++;
    }
  };
  source.subscribe(listener);
  return () => {
    source.unsubscribe(listener);
    return {
      scope:
        "broadcast socket submissions by connection/event; payload bytes after codec, frame bytes include RFC6455 header, neither includes TCP/TLS nor delivery acknowledgment; unavailable codec sizes are counted separately",
      maxGroups: 2048,
      droppedFrames,
      groups: [...groups.values()],
    };
  };
}
