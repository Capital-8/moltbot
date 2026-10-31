import { setMaxListeners } from "node:events";
import type { GatewaySuspension } from "../../packages/gateway-protocol/src/schema/gateway-suspend.js";
import { AsyncContext } from "../shared/async-context.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export type GatewaySuspendAdmissionPhase = GatewaySuspension["phase"];

export type GatewayShutdownTrigger =
  | "SIGTERM"
  | "SIGINT"
  | "SIGUSR2"
  | "hosted Gateway stop"
  | "process exit"
  | "host lifeline closed";
export type GatewayDrainReason =
  | "restart"
  | `${"stop" | "restart"} (${GatewayShutdownTrigger}${"" | `: ${string}`})`;

export type GatewayRootWorkAdmission = {
  origin: string;
  access: "read" | "write";
  references: number;
  released: boolean;
  retiredByReset?: true;
  releaseObservers?: Set<(reason: "settled" | "reset") => void>;
};

type GatewayWorkAdmissionState = {
  rollingAdmission?: { releaseId: string; reads: boolean };
  restartDrainReason: GatewayDrainReason | undefined;
  restartDrainController: AbortController;
  shutdownCleanupController: AbortController;
  restartSignalPending: boolean;
  restartSignalGeneration: number;
  suspendPhase: GatewaySuspendAdmissionPhase;
  suspendGeneration: number;
  suspendAttribution?: string;
  suspendInvalidated?: () => void;
  activeRootWork: Set<GatewayRootWorkAdmission>;
  suspendOpenWaiters: Set<() => void>;
  suspendListeners: Set<(phase: GatewaySuspendAdmissionPhase) => void>;
};

export const currentRootWork = new AsyncContext<GatewayRootWorkAdmission>(
  Symbol.for("openclaw.gatewayWorkAdmissionState"),
);
export const reloadWaitingRoots = new AsyncContext<ReadonlySet<GatewayRootWorkAdmission>>(
  Symbol("gatewayReloadWaitingRoots"),
);
export const rollingStartup = new AsyncContext<{
  active: boolean;
  releaseId: string;
  assertWriter: () => void;
}>(Symbol("gatewayRollingStartupAdmission"));

export function createShutdownCleanupController(): AbortController {
  const controller = new AbortController();
  setMaxListeners(0, controller.signal);
  return controller;
}

export const GATEWAY_WORK_ADMISSION_STATE = resolveGlobalSingleton(
  Symbol.for("openclaw.gatewayWorkAdmissionState"),
  (): GatewayWorkAdmissionState => ({
    restartDrainReason: undefined,
    restartDrainController: new AbortController(),
    shutdownCleanupController: createShutdownCleanupController(),
    restartSignalPending: false,
    restartSignalGeneration: 0,
    suspendPhase: "accepting",
    suspendGeneration: 0,
    activeRootWork: new Set(),
    suspendOpenWaiters: new Set(),
    suspendListeners: new Set(),
  }),
);
