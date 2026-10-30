import type { ControlUiBuildInfo } from "../build-info.ts";

/** Running-Gateway identity the mocked connect hello reports. */
export type ControlUiMockServerIdentity = {
  /** Exact immutable Control UI artifact served by the mocked Gateway. */
  serverBuildId?: string;
  /** Exact Gateway lifecycle generation served in hello. */
  gatewayBootId?: string;
  controlUiBuildSource?: "bundled" | "configured";
  serverVersion?: string;
  /** Startup-bound Gateway commit and build time; empty values are omitted from hello. */
  serverCommit?: string;
  serverBuiltAt?: string;
};

export function normalizeControlUiMockServerIdentity(
  scenario: ControlUiMockServerIdentity,
  shared: Pick<ControlUiBuildInfo, "buildId" | "version"> | null | undefined,
) {
  return {
    serverBuildId: scenario.serverBuildId?.trim() || shared?.buildId || "e2e",
    gatewayBootId: scenario.gatewayBootId?.trim() || "e2e-gateway-boot",
    controlUiBuildSource: scenario.controlUiBuildSource ?? "bundled",
    serverVersion: scenario.serverVersion?.trim() || shared?.version || "e2e",
    serverCommit: scenario.serverCommit ?? "",
    serverBuiltAt: scenario.serverBuiltAt ?? "",
  };
}
