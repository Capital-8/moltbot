// Per-claw mailbox: store-and-forward of opaque, end-to-end authenticated messages.
import type { KeyFingerprint } from "../keys.js";
import type { SignedStatement, UnixSeconds } from "../statements/types.js";

/** Who reads a message: the claw's Gateway, every owner device, or one device by key fingerprint. */
export type MailboxRecipient = "gateway" | "owners" | KeyFingerprint;

/** SAS enrollment steps carried through the mailbox (owner-key spec section 6.1). */
export const ENROLLMENT_STEPS = ["start", "accept", "key", "sealed", "abort"] as const;
/** One of {@link ENROLLMENT_STEPS}. */
export type EnrollmentStep = (typeof ENROLLMENT_STEPS)[number];

/** Message payloads. Every security-relevant payload is a signed statement the reader verifies. */
export type MailboxPayload =
  | { kind: "invite_redemption"; redemption: SignedStatement<"InviteRedemption"> }
  /** R-signed statements: kit enrollment (add_owner_device, re-certifications), rotation. */
  | { kind: "root_statement"; statements: SignedStatement[] }
  | { kind: "revocation"; revocation: SignedStatement<"Revocation"> }
  /** SAS enrollment messages; `data` per step is defined in docs/discovery.md. */
  | { kind: "enrollment"; request_id: string; step: EnrollmentStep; data: Record<string, unknown> }
  /**
   * Gateway hints to owner devices. Never authority: devices confirm at the Gateway directly.
   * `seq_conflict` goes to the one device whose root statement was refused for a stale seq;
   * `ref` is the Gateway's current seq, and the Gateway has republished its snapshot.
   */
  | {
      kind: "notice";
      event:
        | "kit_used"
        | "redemption_pending"
        | "redemption_resolved"
        | "rotation_conflict"
        | "seq_conflict";
      ref: string;
    };

/** Payload kinds the Gateway accepts from its mailbox. Device-signed MembershipChanges are not among them. */
export const GATEWAY_MAILBOX_KINDS = ["invite_redemption", "root_statement", "revocation"] as const;

/** Sender identity as asserted by OpenClaw ID; display only, never authority. */
export type ReportedSender = {
  account_id: string;
  email: string | null;
  display_name: string | null;
  /** Fingerprint of the sending device key, when the request was device-signed. */
  device_fp: KeyFingerprint | null;
  reported_by: "openclaw-id";
};

/** A stored message as returned to its reader. */
export type MailboxMessage = {
  message_id: string;
  claw_id: string;
  to: MailboxRecipient;
  from: ReportedSender;
  /** Coarse location hint for approval prompts ("reported by OpenClaw ID"). */
  location_hint: string | null;
  payload: MailboxPayload;
  received_at: UnixSeconds;
  expires_at: UnixSeconds;
};

/** Largest accepted payload (JSON bytes). */
export const MAILBOX_MAX_PAYLOAD_BYTES = 64 * 1024;
/** Message lifetime: matches the 7-day pending redemption window. */
export const MAILBOX_TTL_SECONDS = 7 * 86400;
/** Longest long-poll wait a reader may request. */
export const MAILBOX_MAX_WAIT_SECONDS = 30;
