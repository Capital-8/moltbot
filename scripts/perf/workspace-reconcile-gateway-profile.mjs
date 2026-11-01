// Diagnostic-only instrumentation. Never include these runs in timing aggregates.
import { ChildProcess } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";
import v8 from "node:v8";

export function createGatewayProfiler(directory) {
  let profile;
  const serialized = new WeakMap();
  const framed = new WeakMap();
  let events = [];
  let scope;
  let receivingBroker;
  const record = (event) => events.push({ atMs: performance.now(), scope, ...event });
  const describe = (message) => {
    if (!message || typeof message !== "object") {
      return {};
    }
    if (message.kind === "openclaw-spawn-broker-frame") {
      return { type: "frame", frameId: message.id, offset: message.offset, bytes: message.total };
    }
    const command = Array.isArray(message.argv) && message.argv[0] === "git";
    const gitOperation = command
      ? message.argv.find((arg) =>
          [
            "fast-import",
            "ls-files",
            "ls-tree",
            "rev-parse",
            "cat-file",
            "pack-objects",
            "index-pack",
            "diff",
            "apply",
            "update-ref",
            "config",
            "init",
            "status",
          ].includes(arg),
        )
      : undefined;
    return {
      type: message.type,
      id: message.id,
      ...(message.argv ? { command: command ? "git" : "other", gitOperation } : {}),
      ...(message.prepare ? { guarded: true } : {}),
      ...(Buffer.isBuffer(message.bytes) ? { contentBytes: message.bytes.byteLength } : {}),
      ...(message.result
        ? {
            stdoutBytes: message.result.stdout?.byteLength,
            stderrBytes: message.result.stderr?.byteLength,
            stdoutCodeUnits:
              typeof message.result.stdout === "string" ? message.result.stdout.length : undefined,
            stderrCodeUnits:
              typeof message.result.stderr === "string" ? message.result.stderr.length : undefined,
          }
        : {}),
    };
  };
  const serialize = v8.serialize;
  v8.serialize = function (value) {
    const begin = performance.now();
    const bytes = serialize(value);
    if (value && typeof value === "object" && typeof value.type === "string") {
      const entry = {
        ...describe(value),
        serializedAtMs: performance.now(),
        serializeMs: performance.now() - begin,
        payloadBytes: bytes.byteLength,
      };
      serialized.set(value, entry);
      // Framing uses subarrays of this exact serialized buffer; no second encoding.
      if (bytes.byteLength > 1024 * 1024) {
        framed.set(bytes.buffer, entry);
      }
    }
    return bytes;
  };
  const deserialize = v8.deserialize;
  v8.deserialize = function (bytes) {
    const begin = performance.now();
    let decoded;
    try {
      decoded = deserialize(bytes);
      return decoded;
    } finally {
      if (receivingBroker !== undefined) {
        record({
          event: "frame-deserialize",
          brokerPid: receivingBroker,
          ...describe(decoded),
          bytes: bytes.byteLength,
          durationMs: performance.now() - begin,
        });
      }
    }
  };
  syncBuiltinESMExports();
  const spawn = ChildProcess.prototype.spawn;
  ChildProcess.prototype.spawn = function (options) {
    const broker = options.args?.some(
      (arg) => typeof arg === "string" && arg.endsWith("/process/spawn-broker/worker.js"),
    );
    const spawnBegin = performance.now();
    const result = spawn.call(this, options);
    if (!broker) {
      return result;
    }
    const brokerPid = this.pid;
    record({ event: "broker-spawn", brokerPid, durationMs: performance.now() - spawnBegin });
    const send = this.send;
    this.send = function (message, ...args) {
      const begin = performance.now();
      const entry =
        serialized.get(message) ??
        (message?.kind === "openclaw-spawn-broker-frame"
          ? framed.get(message.bytes.buffer)
          : undefined);
      const metadata = { brokerPid, ...describe(message) };
      record({
        event: "send",
        ...metadata,
        ...(entry
          ? {
              requestType: entry.type,
              requestId: entry.id,
              payloadBytes: entry.payloadBytes,
              ...(message?.offset > 0
                ? { sinceSerializationMs: begin - entry.serializedAtMs }
                : { serializeMs: entry.serializeMs, senderQueueMs: begin - entry.serializedAtMs }),
            }
          : {}),
      });
      const callback = args.at(-1);
      if (typeof callback === "function") {
        args[args.length - 1] = function (...callbackArgs) {
          record({
            event: "send-ack",
            ...metadata,
            durationMs: performance.now() - begin,
            failed: callbackArgs[0] !== null && callbackArgs[0] !== undefined,
          });
          return Reflect.apply(callback, this, callbackArgs);
        };
      }
      try {
        return Reflect.apply(send, this, [message, ...args]);
      } finally {
        record({ event: "send-return", ...metadata, durationMs: performance.now() - begin });
      }
    };
    const emit = this.emit;
    this.emit = function (event, ...args) {
      if (event !== "message") {
        return Reflect.apply(emit, this, [event, ...args]);
      }
      const begin = performance.now();
      const previousBroker = receivingBroker;
      receivingBroker = brokerPid;
      const metadata = { brokerPid, ...describe(args[0]) };
      record({ event: "receive", ...metadata });
      try {
        return Reflect.apply(emit, this, [event, ...args]);
      } finally {
        receivingBroker = previousBroker;
        record({ event: "receive-return", ...metadata, durationMs: performance.now() - begin });
      }
    };
    return result;
  };
  record({ event: "instrumentation-ready" });
  const saveTrace = async (name) => {
    const captured = events;
    events = [];
    await writeFile(
      path.join(directory, `${name}.broker.json`),
      JSON.stringify({
        method:
          "existing V8 encoding and actual broker IPC; no payload contents or duplicate serialization",
        limits:
          "senderQueueMs is host FIFO wait; send-to-prepared also includes broker preparation, not isolated broker queue; native IPC deserialization requires CPU profile",
        timeOrigin: performance.timeOrigin,
        events: captured,
      }) + "\n",
    );
  };
  return {
    async start(name) {
      await saveTrace(`before-${name}`);
      scope = name;
      record({ event: "profile-start" });
      // Use the same Node 26 native profiler API as the Gateway stall recorder.
      profile = v8.startCpuProfile({ sampleInterval: 1, maxBufferSize: 200_000 });
    },
    async stop(name) {
      record({ event: "profile-stop" });
      const captured = profile.stop();
      profile = undefined;
      scope = undefined;
      await writeFile(path.join(directory, `${name}.cpuprofile`), captured + "\n");
      await saveTrace(name);
    },
  };
}
