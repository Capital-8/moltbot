import assert from "node:assert/strict";
import { once } from "node:events";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { WebSocket, WebSocketServer } from "ws";
import { GATEWAY_CLIENT_IDS } from "../../../packages/gateway-protocol/src/client-info.js";
import {
  NODE_WORKER_ENVIRONMENT_STOP_COMMAND,
  NODE_WORKER_WORKSPACE_EXEC_COMMAND,
} from "../../infra/node-commands.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../../infra/node-runner-inventory.js";
import { rawDataToString } from "../../infra/ws.js";
import type { NodeWorkerWorkspaceRuntime } from "../../node-host/node-worker-workspace.js";
import { acquireTestPortBlock } from "../../test-utils/port-claims.js";
import { parseNodeWorkerEnvironmentStopInput } from "../../worker/node-supervisor-protocol.js";
import {
  NODE_WORKSPACE_DRAIN_COMMAND,
  parseNodeWorkerWorkspaceExecInput,
} from "../../worker/node-workspace-protocol.js";
import { createNodeRegistryRuntime, updateNodeRunnerInventory } from "../node-registry-private.js";
import { NodeRegistry } from "../node-registry.js";
import { makeClient } from "../node-registry.test-helpers.js";
import { gatewayTestTextTransport } from "../server/connection-transport.test-support.js";

// Only the remote endpoint is a fixture. Discovery, dispatch authorization, pending
// invokes, serialization and both directions of socket delivery use the real owners.
export async function openDiskCleanupTransport() {
  const nodeId = "disk-cleanup-node";
  const connId = "disk-cleanup-connection";
  const { nodeRegistry, nodeWorkerSupervisorTransport } = createNodeRegistryRuntime(
    () => new NodeRegistry(),
  );
  const port = await acquireTestPortBlock({ offsets: [0] });
  const server = new WebSocketServer({ host: "127.0.0.1", port: port.port });
  await once(server, "listening");
  const connected = new Promise<WebSocket>((resolve) => {
    server.once("connection", resolve);
  });
  const client = new WebSocket(`ws://127.0.0.1:${port.port}`);
  await once(client, "open");
  const socket = await connected;
  const nodeClient = makeClient(connId, nodeId, [], {
    socket: gatewayTestTextTransport(socket),
    clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
    platform: "test",
    commands: [NODE_WORKER_ENVIRONMENT_STOP_COMMAND, NODE_WORKER_WORKSPACE_EXEC_COMMAND],
  });
  nodeRegistry.register(nodeClient, {
    pairingIdentity: "disk-cleanup-pairing",
    pairingGeneration: "disk-cleanup-generation",
  });
  updateNodeRunnerInventory({
    registry: nodeRegistry,
    nodeId,
    connId,
    declaration: {
      protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
      workerHost: {
        enabled: true,
        capacity: { total: 1, available: 1 },
        environmentSession: 1,
        capturedExecPolicy: true,
        promptContext: 1,
      },
    },
  });
  let endpoint: {
    workspace: NodeWorkerWorkspaceRuntime;
    events: string[];
    beforeStop: () => Promise<void>;
  };
  const commands: string[] = [];
  const errors: unknown[] = [];
  const requests = new Set<Promise<void>>();
  socket.on("message", (data) => {
    try {
      const result: unknown = JSON.parse(rawDataToString(data));
      assert(isRecord(result) && typeof result.id === "string");
      assert(typeof result.ok === "boolean" && typeof result.payloadJSON === "string");
      assert(
        nodeRegistry.handleInvokeResult({
          id: result.id,
          nodeId,
          connId,
          ok: result.ok,
          payloadJSON: result.payloadJSON,
        }),
      );
      endpoint.events.push(result.payloadJSON === "null" ? "stop:ack" : "drain:ack");
    } catch (error) {
      errors.push(error);
    }
  });
  client.on("message", (data) => {
    const handling = (async () => {
      const frame: unknown = JSON.parse(rawDataToString(data));
      assert(isRecord(frame) && frame.event === "node.invoke.request");
      const request = frame.payload;
      assert(isRecord(request) && typeof request.id === "string");
      assert(typeof request.command === "string" && typeof request.paramsJSON === "string");
      commands.push(request.command);
      let payload: unknown;
      if (request.command === NODE_WORKER_ENVIRONMENT_STOP_COMMAND) {
        const input = parseNodeWorkerEnvironmentStopInput(request.paramsJSON);
        endpoint.events.push("stop:received");
        await endpoint.beforeStop();
        await endpoint.workspace.processes.stopEnvironment(input);
        endpoint.events.push("stop:complete");
        payload = null;
      } else {
        assert.equal(request.command, NODE_WORKER_WORKSPACE_EXEC_COMMAND);
        const input = parseNodeWorkerWorkspaceExecInput(request.paramsJSON);
        assert.deepEqual(input.argv, [NODE_WORKSPACE_DRAIN_COMMAND]);
        endpoint.events.push("drain:received");
        payload = await endpoint.workspace.exec(input);
        endpoint.events.push("drain:complete");
      }
      client.send(
        JSON.stringify({ id: request.id, ok: true, payloadJSON: JSON.stringify(payload) }),
      );
    })().catch((error: unknown) => {
      errors.push(error);
    });
    requests.add(handling);
    void handling.finally(() => requests.delete(handling));
  });
  return {
    nodeId,
    transport: nodeWorkerSupervisorTransport,
    commands,
    errors,
    bind(next: typeof endpoint) {
      endpoint = next;
      commands.length = 0;
      errors.length = 0;
    },
    async close() {
      await Promise.all(requests);
      nodeRegistry.unregister(connId);
      client.terminate();
      socket.terminate();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await port.release();
    },
  };
}
