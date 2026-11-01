// Either host an isolated idle Gateway, or send authenticated RPCs using only the fixture HOME.
import { callGateway } from "../../../src/gateway/call.ts";
import { startFixtureGateway } from "./start-fixture-gateway.mts";

if (process.argv[2] === "gateway") {
  const { processLoop } = await startFixtureGateway(Number(process.env.OC_REPRO_GATEWAY_PORT));
  process.send?.({ ready: true });
  await processLoop;
  process.exit(0);
} else {
  process.on(
    "message",
    async (message: {
      id: number;
      port: number;
      method: string;
      params: Record<string, unknown>;
    }) => {
      try {
        const result = await callGateway({
          url: `ws://127.0.0.1:${message.port}`,
          token: "synthetic-gateway-token",
          method: message.method,
          params: message.params,
          timeoutMs: 12_000,
        });
        process.send?.({ id: message.id, result });
      } catch (error) {
        process.send?.({ id: message.id, error: String(error) });
      }
    },
  );
  process.send?.({ ready: true });
}
