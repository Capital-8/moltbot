// The Gateway's OpenClaw ID membership authority (spec sections 4 and 7). It
// owns the claw record: it loads it once, applies writes with the protocol's
// reference rules, writes through to SQLite and reports the side effects the
// Gateway must perform. Discovery is never consulted for any decision here.
import {
  fingerprint,
  isAdmitted,
  linkClaw,
  randomBytes,
  bytesToHex,
  submitRedemption,
  submitStatement,
  verifyOwnerStatement,
  type AuthorityEvent,
  type AuthorityState,
  type Channel,
  type Ed25519PublicKey,
  type IrohEndpointKey,
  parseStatement,
  type SignedStatement,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import { readStoredClaw, writeStoredClaw, type StoredClaw } from "./claw-store.js";

/** What the local link ceremony signs for: the claw's identity and keys. */
export type LinkPreparation = {
  claw_id: string;
  hostname: string;
  k_srv: IrohEndpointKey;
  k_gw: Ed25519PublicKey;
  binding_seq: 1;
  root_epoch: 1;
};

/** The owner-signed result of the local link ceremony. */
export type LinkCommit = {
  root_pub: Ed25519PublicKey;
  /** MembershipChange { op: add_owner_device, cert: OwnerDeviceCert(D1) }, seq 1, signed by R. */
  owner_device: unknown;
  /** ServerBinding(seq 1, epoch 1), signed by R. */
  binding: unknown;
};

/** A refused write: a stable code the UI matches, and detail for logs. */
export type AuthorityRefusal = { ok: false; code: string; detail: string };

/** Accepted write and the effects to perform. */
export type AuthorityAccepted = {
  ok: true;
  status: "applied" | "pending";
  events: AuthorityEvent[];
};

const nowSeconds = () => Math.floor(Date.now() / 1000);

function emptyRecord(clawId: string): StoredClaw {
  return {
    v: 1,
    claw_id: clawId,
    hostname: null,
    authority: null,
    binding: null,
    discovery: {
      owner_account_id: null,
      published_binding_seq: 0,
      published_snapshot_seq: 0,
      mailbox_cursor: null,
    },
  };
}

/** Creates the authority owner over the persisted claw record. */
export function createOpenClawIdAuthority(
  store: {
    read: () => Promise<StoredClaw | undefined>;
    write: (record: StoredClaw) => Promise<void>;
  } = {
    read: readStoredClaw,
    write: writeStoredClaw,
  },
) {
  let record: StoredClaw | undefined;
  let loaded = false;
  // Writes run one at a time so each sees the state the previous one committed.
  let queue: Promise<unknown> = Promise.resolve();

  const load = async (): Promise<StoredClaw | undefined> => {
    if (!loaded) {
      record = await store.read();
      loaded = true;
    }
    return record;
  };

  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => {});
    return next;
  };

  const commit = async (next: StoredClaw) => {
    await store.write(next);
    record = next;
  };

  return {
    /** Loads the record (once); call before reading state synchronously. */
    load,

    /** The current record, if loaded. */
    current(): StoredClaw | undefined {
      return record;
    },

    /** Ensures a claw id exists and returns the values the link ceremony signs. */
    prepareLink(params: {
      kSrv: IrohEndpointKey;
      kGw: Ed25519PublicKey;
      loaderDomain: string;
    }): Promise<LinkPreparation | AuthorityRefusal> {
      return serialize(async () => {
        const current = await load();
        if (current?.authority) {
          return { ok: false, code: "already_linked", detail: "this claw is already linked" };
        }
        const next = current ?? emptyRecord(bytesToHex(randomBytes(16)));
        const hostname = `${next.claw_id}.${params.loaderDomain}`;
        if (next !== current || next.hostname !== hostname) {
          await commit({ ...next, hostname });
        }
        return {
          claw_id: next.claw_id,
          hostname,
          k_srv: params.kSrv,
          k_gw: params.kGw,
          binding_seq: 1,
          root_epoch: 1,
        };
      });
    },

    /**
     * Pins fp(R) at epoch 1, admits owner device D1 and stores the ServerBinding.
     * Only over direct loopback: relayed traffic never runs a root ceremony.
     */
    commitLink(
      input: LinkCommit,
      channel: Channel | undefined,
      expected: { kSrv: IrohEndpointKey; kGw: Ed25519PublicKey },
    ): Promise<AuthorityAccepted | AuthorityRefusal> {
      return serialize(async () => {
        if (channel !== "local_operator") {
          return { ok: false, code: "not_local_operator", detail: "linking needs direct loopback" };
        }
        const current = await load();
        if (!current?.hostname) {
          return { ok: false, code: "not_prepared", detail: "prepare the link first" };
        }
        if (current.authority) {
          return { ok: false, code: "already_linked", detail: "this claw is already linked" };
        }
        const linked = linkClaw({ claw_id: current.claw_id, root_pub: input.root_pub }, channel);
        if (!linked.ok) {
          return { ok: false, code: linked.code, detail: "linking needs direct loopback" };
        }
        const now = nowSeconds();
        const added = await submitStatement(linked.state, input.owner_device, { channel, now });
        if (!added.ok) {
          return { ok: false, code: added.code, detail: added.detail };
        }
        const binding = await verifyBinding(added.state, input.binding, current, expected, now);
        if (!binding.ok) {
          return binding;
        }
        await commit({ ...current, authority: added.state, binding: binding.statement });
        return {
          ok: true,
          status: "applied",
          events: [...added.events, { type: "publish_snapshot" }],
        };
      });
    },

    /** Applies an owner-signed statement that arrived on `channel`. */
    submit(input: unknown, channel: Channel): Promise<AuthorityAccepted | AuthorityRefusal> {
      return serialize(async () => {
        const current = await load();
        if (!current?.authority) {
          return { ok: false, code: "not_linked", detail: "this claw is not linked" };
        }
        const result = await submitStatement(current.authority, input, {
          channel,
          now: nowSeconds(),
        });
        if (!result.ok) {
          return { ok: false, code: result.code, detail: result.detail };
        }
        await commit({ ...current, authority: result.state });
        return { ok: true, status: result.status, events: result.events };
      });
    },

    /** Records an invite redemption from the mailbox as pending (it admits nothing). */
    redeem(
      input: unknown,
      identity: { account_id: string; email: string | null },
    ): Promise<AuthorityAccepted | AuthorityRefusal> {
      return serialize(async () => {
        const current = await load();
        if (!current?.authority) {
          return { ok: false, code: "not_linked", detail: "this claw is not linked" };
        }
        const result = await submitRedemption(current.authority, input, identity, nowSeconds());
        if (!result.ok) {
          return { ok: false, code: result.code, detail: result.detail };
        }
        await commit({ ...current, authority: result.state });
        return { ok: true, status: result.status, events: result.events };
      });
    },

    /** The device key a tunnel-issued token belongs to (from memory; load first). */
    tokenBinding(deviceId: string, role: string): string | undefined {
      return record?.token_bindings?.find(
        (binding) => binding.device_id === deviceId && binding.role === role,
      )?.peer_key;
    },

    /** Records (or replaces) the device key a token was issued to. */
    bindToken(deviceId: string, role: string, peerKey: string): Promise<void> {
      return serialize(async () => {
        const current = await load();
        if (!current) {
          return;
        }
        const others = (current.token_bindings ?? []).filter(
          (binding) => binding.device_id !== deviceId || binding.role !== role,
        );
        await commit({
          ...current,
          token_bindings: [
            ...others,
            { device_id: deviceId, role, peer_key: peerKey, bound_at: nowSeconds() },
          ],
        });
      });
    },

    /** Drops the bindings of removed device keys; returns the (device, role) tokens to revoke. */
    unbindPeers(peerKeys: readonly string[]): Promise<Array<{ deviceId: string; role: string }>> {
      return serialize(async () => {
        const current = await load();
        const removed = (current?.token_bindings ?? []).filter((binding) =>
          peerKeys.includes(binding.peer_key),
        );
        if (current && removed.length > 0) {
          await commit({
            ...current,
            token_bindings: (current.token_bindings ?? []).filter(
              (binding) => !peerKeys.includes(binding.peer_key),
            ),
          });
        }
        return removed.map((binding) => ({ deviceId: binding.device_id, role: binding.role }));
      });
    },

    /** Peer keys the tunnel child may admit right now (members and active owner devices). */
    async admittedPeerKeys(): Promise<{ seq: number; admitted: IrohEndpointKey[] }> {
      const state = (await load())?.authority;
      if (!state) {
        return { seq: 0, admitted: [] };
      }
      return { seq: state.seq, admitted: await listAdmitted(state) };
    },

    /** Records Discovery publication progress (best effort; never authority). */
    recordDiscovery(update: Partial<StoredClaw["discovery"]>): Promise<void> {
      return serialize(async () => {
        const current = await load();
        if (current) {
          await commit({ ...current, discovery: { ...current.discovery, ...update } });
        }
      });
    },
  };
}

export type OpenClawIdAuthority = ReturnType<typeof createOpenClawIdAuthority>;

// Every candidate key that passes the protocol's admission rule.
async function listAdmitted(state: AuthorityState): Promise<IrohEndpointKey[]> {
  const candidates = new Set<IrohEndpointKey>([
    ...Object.values(state.members).flatMap((member) => member.peer_keys),
    ...Object.values(state.owner_devices).flatMap((record) => record.cert.body.peer_keys),
  ]);
  const admitted: IrohEndpointKey[] = [];
  for (const key of candidates) {
    if (isAdmitted(state, key, await fingerprint(key))) {
      admitted.push(key);
    }
  }
  return admitted.toSorted();
}

// Verifies the link binding under the new anchor and that it names exactly this claw.
async function verifyBinding(
  state: AuthorityState,
  input: unknown,
  record: StoredClaw,
  expected: { kSrv: IrohEndpointKey; kGw: Ed25519PublicKey },
  now: number,
): Promise<{ ok: true; statement: SignedStatement<"ServerBinding"> } | AuthorityRefusal> {
  const parsed = parseStatement(input, "ServerBinding");
  if (!parsed.ok) {
    return { ok: false, code: "malformed", detail: parsed.detail };
  }
  const verified = await verifyOwnerStatement(parsed.statement, state.anchor, {
    now,
    isRevoked: (fp) => state.revoked.includes(fp),
  });
  if (!verified.ok) {
    return { ok: false, code: verified.code, detail: verified.detail };
  }
  const body = parsed.statement.body;
  if (
    body.claw_id !== record.claw_id ||
    body.hostname !== record.hostname ||
    body.k_srv !== expected.kSrv ||
    body.k_gw !== expected.kGw ||
    body.binding_seq !== 1 ||
    body.root_epoch !== 1
  ) {
    return { ok: false, code: "target_mismatch", detail: "binding does not name this claw's keys" };
  }
  return { ok: true, statement: parsed.statement };
}
