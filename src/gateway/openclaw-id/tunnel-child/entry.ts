// Tunnel child process entry (forked by the Gateway's tunnel supervisor).
// Owns the iroh endpoint key; the Gateway never reads it. Talks to the
// Gateway over IPC for control and over the ingress socket for data. Logs
// carry `fp:` labels only, never key material.
import {
  TUNNEL_EXIT_KEY_REFUSED,
  TUNNEL_EXIT_UNAVAILABLE,
  type GatewayToTunnelMessage,
  type TunnelStartMessage,
  type TunnelToGatewayMessage,
} from "../tunnel-ipc.js";
import { loadIrohBinding, type IrohBinding } from "./addon.js";
import { KeyFileRefusedError, loadOrCreateEndpointKey, logFingerprint } from "./keyfile.js";
import { IngressServer, TUNNEL_ALPN_BYTES } from "./server.js";

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

function send(message: TunnelToGatewayMessage): void {
  process.send?.(message);
}

// Binds the endpoint, announces ready and serves until the endpoint closes.
async function serve(
  binding: IrohBinding,
  start: TunnelStartMessage,
  takeOver: (handle: (message: GatewayToTunnelMessage) => void) => void,
) {
  let key: Buffer;
  let created: boolean;
  try {
    ({ key, created } = loadOrCreateEndpointKey(start.keyPath));
  } catch (error) {
    log(`key refused: ${(error as Error).message}`);
    process.exit(error instanceof KeyFileRefusedError ? TUNNEL_EXIT_KEY_REFUSED : 1);
  }
  const endpoint = await binding.bind({
    secretKey: key,
    relayUrl: start.relayUrl,
    alpns: [TUNNEL_ALPN_BYTES],
    ...(start.bindAddr ? { bindAddr: start.bindAddr } : {}),
  });
  key.fill(0);
  const server = new IngressServer({
    endpoint,
    target: { socketPath: start.ingress.socketPath },
    proxyToken: start.ingress.proxyToken,
    forwardedProto: start.forwardedProto,
    log,
    onConnectionsChanged: (connections) => send({ type: "state", relayOnline, connections }),
  });
  let relayOnline = false;
  void endpoint.online().then(() => {
    relayOnline = true;
    log("relay online");
    send({ type: "state", relayOnline, connections: server.connectionCount() });
  });

  const handle = (message: GatewayToTunnelMessage) => {
    if (message.type === "membership") {
      server.setMembership(message.admitted);
    } else if (message.type === "ping") {
      send({ type: "pong", id: message.id, rssBytes: process.memoryUsage.rss() });
    }
  };
  takeOver(handle);

  installShutdown(server);
  const endpointId = endpoint.id();
  log(`iroh tunnel up: server=${logFingerprint(endpointId)} key=${created ? "created" : "loaded"}`);
  send({
    type: "ready",
    endpointKey: `iroh:${endpointId}`,
    relayUrl: start.relayUrl,
    directAddrs: endpoint.boundSockets(),
    keyCreated: created,
  });
  await server.run();
}

// SIGTERM/SIGINT: close connections with `shutdown` and the endpoint, then exit 0.
// A lost IPC channel means the Gateway died: exit so no orphan holds the key and socket.
function installShutdown(server: IngressServer): void {
  let stopping = false;
  const stop = async () => {
    if (stopping) {
      return;
    }
    stopping = true;
    await server.shutdown();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
  process.on("disconnect", () => void stop());
}

function main(): void {
  let binding: IrohBinding;
  try {
    binding = loadIrohBinding();
  } catch (error) {
    log(String((error as Error).message));
    process.exit(TUNNEL_EXIT_UNAVAILABLE);
  }
  process.on("disconnect", () => process.exit(0));
  // Messages that arrive before the server is up are replayed to it in order.
  const pending: GatewayToTunnelMessage[] = [];
  let handler: ((message: GatewayToTunnelMessage) => void) | undefined;
  let started = false;
  const takeOver = (handle: (message: GatewayToTunnelMessage) => void) => {
    handler = handle;
    pending.splice(0).forEach(handle);
  };
  process.on("message", (message: GatewayToTunnelMessage) => {
    if (handler) {
      handler(message);
      return;
    }
    if (message.type !== "start" || started) {
      pending.push(message);
      return;
    }
    started = true;
    serve(binding, message, takeOver).catch((error: unknown) => {
      log(`fatal: ${String((error as Error)?.message ?? error).split("\n")[0]}`);
      process.exit(1);
    });
  });
}

main();
