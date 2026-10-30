import { createServer } from "node:http";
import { connect, type Socket } from "node:net";

// Map admitted CONNECT authorities to loopback; callers own listening and teardown.
export function createLoopbackConnectProxy(admit: boolean) {
  const connects: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((_request, response) => response.writeHead(405).end());
  server.on("connection", (socket) => sockets.add(socket));
  server.on("connect", (request, client: Socket, head: Buffer) => {
    const authority = request.url ?? "";
    connects.push(authority);
    if (!admit) {
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = connect(Number(authority.split(":").at(-1)), "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  });
  return { connects, sockets, server };
}
