import { afterEach, describe, expect, it } from "vitest";
import { checkGatewayWsBrowserOrigin } from "../origin-check.js";
import { createOpenClawIdAuthority } from "./authority.js";
import {
  clawOriginOfRecord,
  isOpenClawIdClawOrigin,
  setOpenClawIdClawOriginResolver,
} from "./claw-origin.js";
import { linkedClaw, memoryStore, TEST_K_SRV } from "./openclaw-id.test-support.js";

const CLAW = "https://studio-k7x2q.claws.example.test";

afterEach(() => setOpenClawIdClawOriginResolver(undefined));

describe("OpenClaw ID claw origin", () => {
  it("is the linked claw's https hostname", async () => {
    const claw = await linkedClaw();
    expect(clawOriginOfRecord(claw.authority.current())).toBe(CLAW);
  });

  it("does not exist for a hostname that is only prepared", async () => {
    const authority = createOpenClawIdAuthority(memoryStore());
    const prep = await authority.prepareLink({
      kSrv: TEST_K_SRV,
      kGw: `ed25519:${"11".repeat(32)}`,
      hostname: "studio-k7x2q.claws.example.test",
    });
    expect("ok" in prep).toBe(false);
    expect(authority.current()?.hostname).toBe("studio-k7x2q.claws.example.test");
    expect(clawOriginOfRecord(authority.current())).toBeUndefined();
  });

  it("matches the published origin only, case-insensitively", () => {
    setOpenClawIdClawOriginResolver(() => CLAW);
    expect(isOpenClawIdClawOrigin("https://STUDIO-k7x2q.claws.example.test")).toBe(true);
    expect(isOpenClawIdClawOrigin("https://team-k7x2q.claws.example.test")).toBe(false);
    expect(isOpenClawIdClawOrigin("http://studio-k7x2q.claws.example.test")).toBe(false);
    expect(isOpenClawIdClawOrigin(undefined)).toBe(false);
    setOpenClawIdClawOriginResolver(undefined);
    expect(isOpenClawIdClawOrigin(CLAW)).toBe(false);
  });
});

describe("WebSocket origin policy for a linked claw", () => {
  const tunnel = {
    origin: CLAW,
    requestHost: "localhost",
    isLocalClient: false,
    openclawIdTunnel: true,
  };

  it("accepts the claw's own origin over the tunnel without allowedOrigins", () => {
    setOpenClawIdClawOriginResolver(() => CLAW);
    expect(checkGatewayWsBrowserOrigin(tunnel, {})).toEqual({
      ok: true,
      matchedBy: "openclaw-id-claw",
    });
  });

  it("refuses it before the claw is linked and after OpenClaw ID stops", () => {
    expect(checkGatewayWsBrowserOrigin(tunnel, {}).ok).toBe(false);
    setOpenClawIdClawOriginResolver(() => undefined);
    expect(checkGatewayWsBrowserOrigin(tunnel, {}).ok).toBe(false);
  });

  it("refuses the claw origin on a connection that did not come through the tunnel", () => {
    setOpenClawIdClawOriginResolver(() => CLAW);
    const { openclawIdTunnel: _tunnel, ...direct } = tunnel;
    expect(checkGatewayWsBrowserOrigin(direct, {}).ok).toBe(false);
  });

  it("refuses another claw's origin over the tunnel", () => {
    setOpenClawIdClawOriginResolver(() => CLAW);
    const other = { ...tunnel, origin: "https://team-k7x2q.claws.example.test" };
    expect(checkGatewayWsBrowserOrigin(other, {}).ok).toBe(false);
  });

  it("keeps the configured allowlist working over the tunnel", () => {
    const other = { ...tunnel, origin: "https://team-k7x2q.claws.example.test" };
    const cfg = { gateway: { controlUi: { allowedOrigins: [other.origin] } } };
    expect(checkGatewayWsBrowserOrigin(other, cfg).ok).toBe(true);
  });
});
