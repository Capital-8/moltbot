// OCF-319/323: the lost-root recovery must reach Discovery without trusting its keys.
// Intentionally red contract test; no production regeneration verifier is implemented here.
import { describe, expect, it } from "vitest";
import { regenerateOwnerKey } from "../authority/regenerate.js";
import { snapshotBody } from "../authority/state.js";
import { bytesToBase64url, bytesToHex, concatBytes, utf8 } from "../bytes.js";
import { sha256 } from "../crypto.js";
import { descriptorEvidence, parseClawDescriptor } from "../discovery/descriptor.js";
import { signOwnerKeyRegeneration } from "../enrollment/regeneration.js";
import { canonicalize, type JsonValue } from "../jcs.js";
import { fingerprint } from "../keys.js";
import { signStatement } from "../statements/envelope.js";
import { verifyBindingForPin, type ClawPin } from "../statements/pin.js";
import type { SignedStatement } from "../statements/types.js";
import { parseStatement } from "../statements/validate.js";
import { verifyMembershipSnapshot } from "../statements/verify.js";
import { buildWorld, worldKey, WORLD_HOST, WORLD_NOW } from "../testing/world.js";

// Discovery's parse -> stored pin -> snapshot checks, using only production verifiers.
// This exercises the protocol boundary, not HTTP authentication or D1 transactionality.
async function checkPublication(
  raw: unknown,
  pin: ClawPin & { binding: SignedStatement<"ServerBinding"> },
  snapshot: unknown,
) {
  const parsed = parseClawDescriptor(raw);
  if (!parsed.ok) {
    return { ok: false, detail: parsed.detail };
  }
  const checked = await verifyBindingForPin(descriptorEvidence(parsed.descriptor), pin, {
    host: WORLD_HOST,
    now: WORLD_NOW,
  });
  if (!checked.ok) {
    return checked;
  }
  const signed = parseStatement(snapshot, "MembershipSnapshot");
  if (!signed.ok) {
    return signed;
  }
  const verified = await verifyMembershipSnapshot(signed.statement, checked.binding);
  if (!verified.ok || signed.statement.body.binding_seq !== checked.binding.binding_seq) {
    return { ok: false };
  }
  return { ok: true, pin: checked.pin };
}

// Hash the complete signed binding envelope, not an unsigned subset of its identity.
async function bindingHash(value: JsonValue) {
  return bytesToHex(await sha256(utf8(canonicalize(value))));
}

describe("owner-key regeneration publication (OCF-319/323)", () => {
  it("accepts the bound Gateway's regeneration and rejects a forged one", async () => {
    const world = await buildWorld();
    const root = await worldKey("regenerated-owner-root");
    const browser = await worldKey("regenerating-loopback-browser");
    const signed = await signOwnerKeyRegeneration({
      preparation: {
        ...world.binding.body,
        binding_seq: 2,
        root_epoch: 2,
        seq: world.state.seq + 1,
      },
      root: root.signer,
      device: { device_pub: browser.pub, peer_keys: [browser.peer], label: "loopback" },
      now: WORLD_NOW,
    });
    const committed = await regenerateOwnerKey(
      world.state,
      { root_pub: signed.rootPub, owner_device: signed.ownerDevice },
      { channel: "local_operator", now: WORLD_NOW },
    );
    expect(committed.ok).toBe(true);
    const snapshot = await signStatement(
      "MembershipSnapshot",
      snapshotBody(committed.state, 2, WORLD_NOW),
      world.gateway.signer,
    );
    // Persisted authenticated predecessor: an old-root fingerprint alone cannot pin K_gw.
    const pin = {
      claw_id: world.state.claw_id,
      root_fp: await fingerprint(world.rootPub),
      root_epoch: 1,
      binding_seq: 1,
      binding: world.binding,
    } satisfies ClawPin & { binding: SignedStatement<"ServerBinding"> };

    // Encode the proposed wire statement independently: the production type does not exist yet.
    // Its only signing authority is K_gw from the old R-signed binding, never the old root.
    const body = {
      claw_id: world.state.claw_id,
      hostname: WORLD_HOST,
      old_root_fp: pin.root_fp,
      old_root_epoch: 1,
      old_binding_hash: await bindingHash(world.binding),
      old_binding_seq: 1,
      new_root_pub: signed.rootPub,
      new_epoch: 2,
      new_binding_hash: await bindingHash(signed.binding),
      binding_seq: 2,
      seq: committed.state.seq,
      resolves_through_epoch: 1,
      issued_at: WORLD_NOW,
    };
    const input = concatBytes(utf8("openclaw/RootRegeneration/v1\0"), utf8(canonicalize(body)));
    const statement = {
      v: 1,
      type: "RootRegeneration",
      body,
      signer: world.gateway.pub,
      chain: [],
      alg: "ed25519",
      sig: bytesToBase64url(await world.gateway.signer.sign(input)),
    };
    const proof = {
      previous_root_pub: world.rootPub,
      previous_binding: world.binding,
      statement,
      binding: signed.binding,
    };
    const descriptor = {
      v: 1,
      claw_id: world.state.claw_id,
      transport: "iroh",
      relay_url: "https://relay.example.test/",
      root_pub: signed.rootPub,
      rotations: [],
      regenerations: [proof],
      binding: signed.binding,
      published_at: WORLD_NOW,
    };

    // Even a cryptographically valid attacker signature must not replace the bound K_gw.
    const forged = {
      ...descriptor,
      regenerations: [
        {
          ...proof,
          statement: {
            ...statement,
            signer: world.mallory.pub,
            sig: bytesToBase64url(await world.mallory.signer.sign(input)),
          },
        },
      ],
    };
    expect(await checkPublication(forged, pin, snapshot)).toMatchObject({ ok: false });

    // R1 may be compromised: its replacement predecessor must not overwrite the cached K_gw.
    const substitutedPrevious = await signStatement(
      "ServerBinding",
      { ...world.binding.body, k_gw: world.mallory.pub },
      world.root,
    );
    const substitutedNext = await signStatement(
      "ServerBinding",
      { ...signed.binding.body, k_gw: world.mallory.pub },
      root.signer,
    );
    const substitutedBody = {
      ...body,
      old_binding_hash: await bindingHash(substitutedPrevious),
      new_binding_hash: await bindingHash(substitutedNext),
    };
    const substitutedStatement = {
      ...statement,
      body: substitutedBody,
      signer: world.mallory.pub,
      sig: bytesToBase64url(
        await world.mallory.signer.sign(
          concatBytes(utf8("openclaw/RootRegeneration/v1\0"), utf8(canonicalize(substitutedBody))),
        ),
      ),
    };
    const substituted = {
      ...descriptor,
      binding: substitutedNext,
      regenerations: [
        {
          ...proof,
          previous_binding: substitutedPrevious,
          statement: substitutedStatement,
          binding: substitutedNext,
        },
      ],
    };
    const forgedSnapshot = await signStatement(
      "MembershipSnapshot",
      snapshot.body,
      world.mallory.signer,
    );
    expect(await checkPublication(substituted, pin, forgedSnapshot)).toMatchObject({ ok: false });
    expect(await checkPublication(descriptor, pin, snapshot)).toMatchObject({
      ok: true,
      pin: {
        claw_id: pin.claw_id,
        root_fp: await fingerprint(signed.rootPub),
        root_epoch: 2,
        binding_seq: 2,
      },
    });
  });
});
