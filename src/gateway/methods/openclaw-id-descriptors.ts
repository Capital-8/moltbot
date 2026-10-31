// OpenClaw ID remote access methods, part of the canonical core method table
// (core-descriptors.ts). Status is a summary any reader may see; people is
// owner-only, which the handler enforces on top of the admin scope.
import { CONTROL_PLANE_WRITE } from "./core-descriptor-options.js";
import type { CoreGatewayMethodSpecRow } from "./core-descriptor-types.js";

/** Method rows for the openclaw-id handler family. */
export const OPENCLAW_ID_METHOD_SPECS = [
  ["openclawId.status", "openclaw-id", "operator.read", "2026.10"],
  ["openclawId.people", "openclaw-id", "operator.admin", "2026.10"],
  ["openclawId.authority", "openclaw-id", "operator.admin", "2026.10", CONTROL_PLANE_WRITE],
] as const satisfies readonly CoreGatewayMethodSpecRow[];
