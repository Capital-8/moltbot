// Gateway owner of experimental OpenClaw ID remote access (Labs).
// While the Labs switch is off this module does nothing: it starts no child
// process, opens no sockets and contacts no OpenClaw ID, Discovery or relay
// service. Everything heavier is imported only after the switch turns on.
import type { GatewayOpenClawIdConfig } from "../../config/types.gateway.js";

/** What the Control UI and `openclaw status` show for OpenClaw ID. */
export type OpenClawIdStatus =
  | { state: "off" }
  | { state: "unconfigured"; missing: Array<keyof GatewayOpenClawIdConfig> }
  | { state: "unavailable"; reason: string };

type OpenClawIdLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

/** True only for an explicit `gateway.openclawId.enabled: true`. */
export function isOpenClawIdEnabled(config: GatewayOpenClawIdConfig | undefined): boolean {
  return config?.enabled === true;
}

/** Creates the OpenClaw ID owner. It stays inert until the Labs switch is on. */
export function createOpenClawIdService(params: {
  getConfig: () => GatewayOpenClawIdConfig | undefined;
  log: OpenClawIdLogger;
}) {
  let status: OpenClawIdStatus = { state: "off" };

  return {
    /** Applies the current config: start, reconfigure or stop. */
    async reconcileRuntimePolicy(): Promise<void> {
      const config = params.getConfig();
      if (!isOpenClawIdEnabled(config)) {
        status = { state: "off" };
        return;
      }
      if (!config?.relayUrl) {
        status = { state: "unconfigured", missing: ["relayUrl"] };
        return;
      }
      status = { state: "unavailable", reason: "tunnel transport is not installed" };
      params.log.warn("openclaw-id: enabled, but the tunnel transport is not installed");
    },
    /** Current status; never touches the network. */
    status(): OpenClawIdStatus {
      return status;
    },
    /** Stops everything this owner started. */
    async stop(): Promise<void> {
      status = { state: "off" };
    },
  };
}

export type OpenClawIdService = ReturnType<typeof createOpenClawIdService>;
