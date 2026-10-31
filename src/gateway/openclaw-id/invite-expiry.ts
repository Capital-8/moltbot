// Pending invite redemptions expire after seven days without an owner decision
// (spec section 6.3). The protocol's reference authority does not model time
// passing, so the Gateway sweeps expired redemptions before every write and
// derives the same answer when it only reads.
import {
  PENDING_REDEMPTION_TTL_SECONDS,
  type AuthorityState,
  type InviteRecord,
  type UnixSeconds,
} from "../../../packages/openclaw-id-protocol/src/index.js";

/** True when a pending redemption has waited longer than the pending window. */
export function isPendingExpired(invite: InviteRecord, now: UnixSeconds): boolean {
  return (
    invite.status === "pending" &&
    invite.pending !== null &&
    invite.pending.requested_at + PENDING_REDEMPTION_TTL_SECONDS <= now
  );
}

/**
 * Consumes every expired pending redemption. The invite is used up and nothing
 * is admitted, exactly as if an owner had denied it. Returns the expired ids.
 */
export function expirePendingRedemptions(
  state: AuthorityState,
  now: UnixSeconds,
): { state: AuthorityState; expired: string[] } {
  const expired = Object.entries(state.invites)
    .filter(([, invite]) => isPendingExpired(invite, now))
    .map(([inviteId]) => inviteId);
  if (expired.length === 0) {
    return { state, expired };
  }
  const invites = { ...state.invites };
  for (const inviteId of expired) {
    invites[inviteId] = { ...invites[inviteId]!, status: "consumed", pending: null };
  }
  return { state: { ...state, invites }, expired };
}
