// The linked claw's own browser origin, https://<claw hostname>. The loader serves the Control UI
// there and its WebSocket reaches the Gateway only through the OpenClaw ID tunnel, so the Gateway
// accepts that origin for tunnel connections without a gateway.controlUi.allowedOrigins entry.
// The OpenClaw ID service publishes the resolver while remote access runs; it reads the live claw
// record, so a link adds the origin at once and an unlink or reset removes it.

/** Returns the linked claw's origin, or undefined while the claw is not linked. */
export type OpenClawIdClawOriginResolver = () => string | undefined;

let resolver: OpenClawIdClawOriginResolver | undefined;

/** Publishes or clears the resolver (the OpenClaw ID service does this while it is on). */
export function setOpenClawIdClawOriginResolver(
  next: OpenClawIdClawOriginResolver | undefined,
): void {
  resolver = next;
}

/**
 * The origin of a stored claw record: https://<hostname> once the claw is linked (it has an
 * authority). A hostname that is only prepared for a link does not count.
 */
export function clawOriginOfRecord(
  record: { authority?: unknown; hostname?: string | null } | undefined,
): string | undefined {
  return record?.authority && record.hostname ? `https://${record.hostname}` : undefined;
}

// Normalizes an origin string for comparison; undefined for anything that is not a URL origin.
function normalizedOrigin(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const origin = new URL(value.trim()).origin;
    return origin === "null" ? undefined : origin.toLowerCase();
  } catch {
    return undefined;
  }
}

/** True when `origin` is the linked claw's own origin. */
export function isOpenClawIdClawOrigin(origin: string | undefined): boolean {
  const claw = normalizedOrigin(resolver?.());
  return claw !== undefined && normalizedOrigin(origin) === claw;
}
