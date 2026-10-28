import { isDeepStrictEqual } from "node:util";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export type CrabboxRuntimeInstallationIdentity = {
  nodeBootstrap: {
    sha256: string;
    bytes: number;
    manifestSha256: string;
    buildId: string;
    openclawVersion: string;
    enabledPluginIds: readonly string[];
  };
  workerBundle: { sha256: string; bytes: number; packageRelativePath: string };
};

/** A completed install result, never live authority or permission to skip native verification. */
export type CrabboxRuntimeInstallation = CrabboxRuntimeInstallationIdentity & {
  schema: "openclaw.runtime-installation.v1";
  disposition: "installed" | "existing-verified";
  installationVerified: true;
};

/** Parse the same owner result from the existing producer manifest or capture input. */
export function parseCrabboxRuntimeInstallation(
  value: unknown,
  expected: CrabboxRuntimeInstallationIdentity,
): CrabboxRuntimeInstallation {
  if (
    !isRecord(value) ||
    value.schema !== "openclaw.runtime-installation.v1" ||
    value.installationVerified !== true ||
    (value.disposition !== "installed" && value.disposition !== "existing-verified") ||
    !isDeepStrictEqual(value.nodeBootstrap, expected.nodeBootstrap) ||
    !isDeepStrictEqual(value.workerBundle, expected.workerBundle)
  ) {
    throw new Error("Runtime installation result differs from the admitted artifacts");
  }
  return {
    schema: "openclaw.runtime-installation.v1",
    disposition: value.disposition === "installed" ? "installed" : "existing-verified",
    installationVerified: true,
    nodeBootstrap: expected.nodeBootstrap,
    workerBundle: expected.workerBundle,
  };
}

/** Consume only stdout from one successful native installer command. */
export function readCrabboxRuntimeInstallation(
  output: string,
  expected: CrabboxRuntimeInstallationIdentity,
): CrabboxRuntimeInstallation {
  const lines = output.split("\n").filter((line) => line.startsWith("OPENCLAW_RUNTIME_INSTALLED:"));
  if (lines.length !== 1 || lines[0]!.length > 16384) {
    throw new Error("Native installer must return one bounded runtime installation result");
  }
  return parseCrabboxRuntimeInstallation(
    JSON.parse(lines[0]!.slice("OPENCLAW_RUNTIME_INSTALLED:".length)),
    expected,
  );
}

/** Installation result reporting for the private bootstrap. */
export const CRABBOX_RUNTIME_VERIFICATION_SOURCE = `
  // Project only verification/publication already completed by the installer.
  const reportRuntimeInstallation = (disposition) => console.log("OPENCLAW_RUNTIME_INSTALLED:" + JSON.stringify({
    schema: "openclaw.runtime-installation.v1", installationVerified: true, disposition,
    nodeBootstrap: {
      sha256: bootstrap.sha256, bytes: bootstrap.bytes,
      manifestSha256: bootstrap.manifestSha256, buildId: bootstrap.buildId,
      openclawVersion: bootstrap.openclawVersion, enabledPluginIds: bootstrap.enabledPluginIds,
    },
    workerBundle: { sha256: workerBundle.sha256, bytes: workerBundle.bytes,
      packageRelativePath: workerBundle.packageRelativePath },
  }));

`;
