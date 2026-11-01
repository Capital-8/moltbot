import { startGatewayServer } from "../../../src/gateway/server.ts";

/** Use the production signal owner when the fixture sends an actual stop signal. */
export async function startFixtureGateway(port: number) {
  let processLoop: Promise<void> | undefined;
  let server: Awaited<ReturnType<typeof startGatewayServer>>;
  const serverOptions = {
    bind: "loopback",
    auth: { mode: "token", token: "synthetic-gateway-token" },
    controlUiEnabled: false,
  } as const;
  if (
    process.env.OC_REPRO_MODE?.includes("sigterm") &&
    process.env.OC_REPRO_GATEWAY_PHASE !== "recovered"
  ) {
    const { runGatewayLoop } = await import("../../../src/cli/gateway-cli/run-loop.js");
    const { defaultRuntime } = await import("../../../src/runtime.js");
    server = await new Promise((resolve, reject) => {
      processLoop = runGatewayLoop({
        runtime: defaultRuntime,
        ownsProcessLifecycle: true,
        lockPort: port,
        start: async ({ requestHotReloadRecovery, ...startupOptions } = {}) => {
          const started = await startGatewayServer(port, {
            ...serverOptions,
            ...startupOptions,
            ...(requestHotReloadRecovery ? { hotReloadRecovery: requestHotReloadRecovery } : {}),
          });
          resolve(started);
          return started;
        },
      });
      void processLoop.catch(reject);
    });
  } else {
    server = await startGatewayServer(port, serverOptions);
  }
  return { server, processLoop };
}
