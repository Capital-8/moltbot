// Response shapes of the OpenClaw ID Gateway methods (openclawId.*).
import type { OpenClawIdLinkPreparation } from "./openclaw-id-link.ts";

export type OpenClawIdTunnelStatus =
  | { state: "stopped" }
  | { state: "starting"; restarts: number }
  | {
      state: "running";
      endpointKey: string;
      relayUrl: string;
      relayOnline: boolean;
      /** The relay's reason when it refused this claw (not yet admitted by Discovery). */
      relayDenied?: string | null;
      connections: number;
      restarts: number;
    }
  | {
      state: "backoff";
      retryInMs: number;
      restarts: number;
      crashLooping: boolean;
      lastExit: string;
    }
  | { state: "unavailable"; reason: string; retryInMs?: number };

/** One invite as the Gateway lists it to owners. */
export type OpenClawIdInvite = {
  inviteId: string;
  label: string;
  role: "operator" | "viewer";
  audience: { kind: "account_id" | "email"; value: string };
  createdAt: number;
  expiresAt: number;
  status: "open" | "pending" | "approved" | "denied" | "expired";
  pending?: {
    accountId: string;
    devicePub: string;
    peerKey: string;
    requestedAt: number;
    decideBy: number;
    /** Reported by OpenClaw ID; display only. */
    reported: { email: string | null; displayName: string | null; locationHint: string | null };
  };
};

export type OpenClawIdPublication =
  | { state: "published"; ownerAccountId: string | null; snapshotSeq: number }
  | { state: "needs_enrollment_code" }
  | { state: "failed"; code: string; message: string };

export type OpenClawIdStatusResult = {
  status:
    | { state: "off" }
    | { state: "unconfigured"; missing: string[] }
    | { state: "on"; tunnel: OpenClawIdTunnelStatus }
    | { state: "failed"; reason: string };
  link: {
    linked: boolean;
    clawId?: string;
    hostname?: string;
    rootPub?: string;
    seq?: number;
    ownerDevices?: Array<{ devicePub: string; label: string; peerKeys: string[]; cert: unknown }>;
    members?: Array<{ accountId: string; role: string; peerKeys: string[]; email?: string | null }>;
    invites?: OpenClawIdInvite[];
    publication?: OpenClawIdPublication;
  };
  /** How this browser reaches the Gateway: only `local_operator` may link. */
  channel: "local_operator" | "tunnel" | null;
  services: { issuerUrl: string | null; discoveryUrl: string | null; loaderDomain: string | null };
};

export type { OpenClawIdLinkPreparation };
