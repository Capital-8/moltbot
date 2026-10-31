// Gateway owner of experimental OpenClaw ID remote access (Labs).
// While the Labs switch is off this module does nothing: it starts no child
// process, opens no sockets and contacts no OpenClaw ID, Discovery or relay
// service. Everything heavier is imported only after the switch turns on.
import type { Server as HttpServer } from "node:http";
import type { GatewayOpenClawIdConfig } from "../../config/types.gateway.js";
import type { TunnelRuntime, TunnelRuntimeSettings } from "./tunnel-runtime.js";
import type { TunnelSupervisorStatus } from "./tunnel-supervisor.js";

/** What the Control UI and `openclaw status` show for OpenClaw ID. */
export type OpenClawIdStatus =
  | { state: "off" }
  | { state: "unconfigured"; missing: Array<keyof GatewayOpenClawIdConfig> }
  | { state: "on"; tunnel: TunnelSupervisorStatus }
  | { state: "failed"; reason: string };

type OpenClawIdLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

/** True only for an explicit `gateway.openclawId.enabled: true`. */
export function isOpenClawIdEnabled(config: GatewayOpenClawIdConfig | undefined): boolean {
  return config?.enabled === true;
}

/** The settings a tunnel runtime needs, or the config keys still missing. */
function resolveSettings(
  config: GatewayOpenClawIdConfig,
  stateDir: string,
): TunnelRuntimeSettings | { missing: Array<keyof GatewayOpenClawIdConfig> } {
  if (!config.relayUrl) {
    return { missing: ["relayUrl"] };
  }
  return {
    stateDir,
    relayUrl: config.relayUrl,
    // Browsers reach a linked claw over the HTTPS loader origin.
    forwardedProto: config.loaderDomain ? "https" : "http",
  };
}

function sameSettings(a: TunnelRuntimeSettings, b: TunnelRuntimeSettings): boolean {
  return (
    a.stateDir === b.stateDir && a.relayUrl === b.relayUrl && a.forwardedProto === b.forwardedProto
  );
}

/** Creates the OpenClaw ID owner. It stays inert until the Labs switch is on. */
export function createOpenClawIdService(params: {
  getConfig: () => GatewayOpenClawIdConfig | undefined;
  getStateDir: () => string;
  /** The Gateway's primary HTTP listener; relayed requests are handed to it. */
  getGatewayServer: () => HttpServer | undefined;
  log: OpenClawIdLogger;
  /** Admitted device peer keys; nobody is admitted until a claw is linked. */
  getMembership?: () => { seq: number; admitted: string[] };
}) {
  let status: OpenClawIdStatus = { state: "off" };
  let runtime: TunnelRuntime | undefined;
  // Serializes start/stop so overlapping config reloads apply in order.
  let queue: Promise<void> = Promise.resolve();
  const membership = params.getMembership ?? (() => ({ seq: 0, admitted: [] }));

  const stopRuntime = async () => {
    const current = runtime;
    runtime = undefined;
    await current?.stop();
  };

  const reconcile = async () => {
    const config = params.getConfig();
    if (!config || !isOpenClawIdEnabled(config)) {
      await stopRuntime();
      status = { state: "off" };
      return;
    }
    const settings = resolveSettings(config, params.getStateDir());
    if ("missing" in settings) {
      await stopRuntime();
      status = { state: "unconfigured", missing: settings.missing };
      return;
    }
    if (runtime && sameSettings(runtime.settings, settings)) {
      return;
    }
    await stopRuntime();
    try {
      const { startTunnelRuntime } = await import("./tunnel-runtime.js");
      runtime = await startTunnelRuntime({
        settings,
        gatewayServer: params.getGatewayServer,
        membership,
        log: params.log,
        onStatus: (tunnel) => {
          status = { state: "on", tunnel };
        },
      });
      status = { state: "on", tunnel: runtime.supervisor.status() };
    } catch (error) {
      status = { state: "failed", reason: String((error as Error)?.message ?? error) };
      params.log.warn(`openclaw-id: could not start remote access: ${status.reason}`);
    }
  };

  return {
    /** Applies the current config: start, reconfigure or stop. */
    reconcileRuntimePolicy(): Promise<void> {
      queue = queue.then(reconcile, reconcile);
      return queue;
    },
    /** Pushes current membership to a running tunnel child. */
    refreshMembership(): void {
      runtime?.refreshMembership();
    },
    /** Current status; never touches the network. */
    status(): OpenClawIdStatus {
      return status;
    },
    /** Stops everything this owner started. */
    stop(): Promise<void> {
      const stop = async () => {
        await stopRuntime();
        status = { state: "off" };
      };
      queue = queue.then(stop, stop);
      return queue;
    },
  };
}

export type OpenClawIdService = ReturnType<typeof createOpenClawIdService>;
