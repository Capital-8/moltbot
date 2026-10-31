/**
 * True when an embedding loader carries this document's Gateway traffic
 * (the OpenClaw ID claw loader). That loader's Service Worker owns the origin's
 * root scope, so the Control UI must not register its own worker there.
 */
export function hasEmbedderTransport(): boolean {
  return typeof globalThis.__openclawTransport !== "undefined";
}

export function isRemoteControlUiIngress(): boolean {
  return (
    typeof document !== "undefined" &&
    document.documentElement.getAttribute("data-openclaw-remote-ingress") === "true"
  );
}
