// Publishes the claw descriptor and K_gw-signed membership snapshots to the
// Discovery mirror. Discovery stores them; clients verify them against their
// own pins, so a failed or withheld publication never changes who has access.
import {
  signStatement,
  snapshotBody,
  type ClawDescriptor,
  type StatementSigner,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import type { StoredClaw } from "./claw-store.js";
import type { DiscoveryClient } from "./discovery-client.js";

/** Outcome of one publication attempt, shown in status. */
export type PublishOutcome =
  | { state: "published"; ownerAccountId: string | null; snapshotSeq: number }
  | { state: "needs_enrollment_code" }
  | { state: "failed"; code: string; message: string };

/** Builds the descriptor for a linked claw. */
export function buildDescriptor(
  record: StoredClaw,
  relayUrl: string,
  now: number,
): ClawDescriptor | undefined {
  if (!record.authority || !record.binding) {
    return undefined;
  }
  return {
    v: 1,
    claw_id: record.claw_id,
    transport: "iroh",
    relay_url: relayUrl,
    root_pub: record.authority.anchor.root_pub,
    rotations: [],
    binding: record.binding,
    published_at: now,
  };
}

/**
 * Registers the claw on first publication (with the owner's one-time enrollment
 * code), otherwise republishes the descriptor, then publishes a fresh snapshot.
 */
export async function publishClaw(params: {
  record: StoredClaw;
  relayUrl: string;
  client: DiscoveryClient;
  signer: StatementSigner;
  enrollmentCode?: string;
}): Promise<PublishOutcome> {
  const now = Math.floor(Date.now() / 1000);
  const descriptor = buildDescriptor(params.record, params.relayUrl, now);
  const state = params.record.authority;
  if (!descriptor || !state) {
    return { state: "failed", code: "not_linked", message: "this claw is not linked" };
  }
  let ownerAccountId = params.record.discovery.owner_account_id;
  try {
    if (!ownerAccountId) {
      if (!params.enrollmentCode) {
        return { state: "needs_enrollment_code" };
      }
      ownerAccountId = (await params.client.registerClaw(params.enrollmentCode, descriptor))
        .owner_account_id;
    } else {
      await params.client.publishDescriptor(descriptor);
    }
    const snapshot = await signStatement(
      "MembershipSnapshot",
      snapshotBody(state, descriptor.binding.body.binding_seq, now),
      params.signer,
    );
    await params.client.publishSnapshot(descriptor.claw_id, snapshot);
    return { state: "published", ownerAccountId, snapshotSeq: state.seq };
  } catch (error) {
    const code = (error as { code?: string }).code ?? "unavailable";
    return { state: "failed", code, message: String((error as Error).message ?? error) };
  }
}
