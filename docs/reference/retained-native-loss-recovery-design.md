---
doc-schema-version: 1
title: "Retained native conversation recovery design"
summary: "Proposed owner association and available-history recovery after confirmed loss of a retained worker"
read_when:
  - Implementing retained native conversation recovery after confirmed worker loss
  - Reviewing placement lineage, native binding compatibility, or rollback
---

# Retained native conversation recovery design

**Proposed contract; runtime implementation is pending.** Recover the available
conversation into a new ordinary Codex thread after confirmed loss of its worker
and private disk. Preserve the OpenClaw session ID, mirrored workspace, available
transcript, and unresolved-effect safeguards. Report partial recovery and a new
native thread ID. Missing native-only history and private files remain unavailable.
Stop/resume on an intact disk must continue the same native thread.

This design is independent of credential repairs and sealed runtime candidates.
It authorizes no deployment, provider fault, retry, or model input.

## Existing owners and the missing contract

| Responsibility                    | Existing owner                                                                              | Required change                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Confirm loss and admit redispatch | src/gateway/worker-environments/placement-lifecycle.worker.ts: startWorkerPlacementDispatch | Preserve the predecessor fact in the dispatch transaction.                      |
| Publish current placement         | Placement store worker mutations and committed postimages                                   | Carry recorded lineage through replacement activation.                          |
| Bind a native thread              | extensions/codex/src/app-server/session-binding.ts and binding codec                        | Record exact placement association; replace only the expected ordinary binding. |
| Select available conversation     | Codex run-attempt-prompt.ts and context-engine-history.ts                                   | Reuse bounded quoted history selection and seed.                                |
| Admit native effects              | Existing prepared binding authority, attestation, and placement claim                       | Check current authority at native effects and binding commit.                   |
| Clean up                          | Existing session deletion, placement deletion, provisional thread lifecycle                 | Remove owned facts with their existing records.                                 |

Redispatch clears predecessor environment and epoch fields. Native bindings retain
runtime and environment-selection fingerprints, but no exact placement owner.
A retained binding that cannot resume therefore reaches the existing-thread
refusal in thread-lifecycle-run.ts. Generic workspace replacement alone cannot
authorize native binding replacement.

Repository recovery provenance records restored source and unavailable private
contents. It is disclosure, not native replacement authority. It must not be
required when an accepted checkpoint survives worker loss.

## Proposed persisted data

Keep facts with existing owners. Add no sidecar, separate recovery service,
public recovery RPC, bearer token, or process-global authorization cache.

### Placement recovery fact

Add nullable confirmed_loss_recovery_json to worker_session_placements. Decode
once through the placement record owner into confirmedLossRecovery. Proposed
closed version-1 values:

```ts
type PlacementOwner = {
  agentId: string;
  sessionKey: string;
  sessionId: string;
  environmentId: string;
  ownerEpoch: number;
  retentionOwnerBinding?: string;
};

type ConfirmedLossRecovery = {
  version: 1;
  predecessor: PlacementOwner;
  predecessorGeneration: number;
  replacementDispatchGeneration: number;
};
```

Reuse existing ID, epoch, generation, and retention-binding validators. Required
numbers follow their existing owner contracts; add no second coercion policy.
These facts contain no credentials, paths, messages, or policy fingerprints.

Mint lineage only when an explicit expected failed placement passes the existing
confirmed-gone check, has a real predecessor environment/epoch, and has no turn
claim, pending workspace result, reconciliation journal, or move. Include the
retention owner binding for retained predecessors. Revalidate that exact owner
and binding inside the same synchronous writer transaction.

A timeout, disconnected node, unknown provider observation, merely Stopped worker,
changed runtime, or failed native resume never mints lineage. The transaction
assigns replacementDispatchGeneration when changing state to requested, recording
predecessorGeneration from the expected terminal placement. Provisioning, syncing,
starting, and activation preserve that dispatch identity even when their own
transition generations advance. Existing writer transitions validate lineage
against their expected postimages. A later
confirmed-loss redispatch replaces it with that dispatch's immediate predecessor;
ordinary redispatch clears superseded lineage. Session/placement deletion removes
it with the row. No background timestamp expiry is needed.

### Native binding association

Add optional workerPlacementOwner: PlacementOwner to the private ordinary Codex
binding. Record it at successful fresh-thread creation or successful
existing-thread admission using exact prepared placement authority. Never derive
it from a home path, current replacement, or failed native request.

A recovered successor carries its new workerPlacementOwner and a closed
recoveredFrom value containing the predecessor owner and predecessor thread ID.
That binding commit is the consumption receipt. No second acknowledgment write
to the placement database is necessary.

Binding owner equality uses session/agent/environment/epoch/retention ownership,
not a historical transition generation. Stop, reclaim, and activation can advance
placement generations without changing that physical owner. The lineage retains
the exact terminal predecessor generation and replacement dispatch generation for
its transaction and later postimage continuity checks.

Lineage establishes eligibility to consider recovery. The current replacement
placement and existing binding authority still authorize each effect.

## Admission and commit ordering

1. Read committed lineage through existing placement preparation. Require the
   same agent, canonical session key, and session ID; preserved replacement dispatch
   lineage, current environment owner, generation, and claim. Carry typed prepared facts through the
   existing sandbox/attempt context, without public tool argument changes.
2. Read the private binding under its existing lease. Require an ordinary binding
   whose recorded owner equals the lineage predecessor. Preserve restrictions on
   native-only, adopted, supervised, pending-supervision, and native-model-owned
   bindings: loss does not supply a host-owned replacement model.
3. If a committed successor already matches this replacement owner and its
   recoveredFrom receipt, resume it normally. Never seed it twice.
4. Assemble available history through the canonical context engine and finite
   allowance. Exclude the new request by current idempotency key. Historical tool
   records remain quoted data. Overflow, required attachment failure, or absent
   model policy fails visibly before binding replacement.
5. Create a provisional thread through existing thread/start and all current
   model, provider, configuration, tool-surface, and attestation checks. Await
   seedCodexHistory / thread/inject_items acknowledgment before binding commit.
   Never submit historical requests through turn/start.
6. Replace the expected binding through existing mutation/CAS. Every retry checks
   expected thread, client, placement association, and relevant captured binding
   identity, rather than thread ID alone. Recheck current replacement authority
   immediately before commit. Commit new association and receipt together.
7. Submit only the distinct newly admitted current input through normal admission.
   Publish partial-recovery status through the existing session outcome path.
   Never replay a failed or uncertain old input.

Seed or attestation failure retains the predecessor and uses existing provisional
cleanup. Crash before commit may leave an uncommitted provisional thread; ordinary
owned cleanup handles it without granting recovery. Crash after commit sees the
successor receipt and resumes it. The databases need no distributed transaction:
lineage persists independently, while binding commit is the sole native cutover.

## Existing sessions and predecessor reconstruction

Existing fingerprints cannot safely reconstruct a lost physical owner:

- thread-fingerprints.ts serializes environment selection as stable JSON;
  execution carriers can include random IDs, routes, and ephemeral ports.
- plugin-app-cache-key.ts serializes endpoint, connection class, workspace root,
  and native handshake identity.
- client-initialize.ts observes version, user agent, Codex home, and platform,
  without provider environment ID, owner epoch, or placement generation.
- Worker-hosted node-app-server.runtime.ts derives native home from runtime
  directory and session ID. Replacement disks can report the same path.
  Its process-owned environment registration is not reconstructible from an old
  environment row.

These are JSON serializations, not opaque hashes. Equality proves equal inputs,
not a unique predecessor disk; parsing them cannot supply the missing association.

For an existing unassociated binding on an intact worker, record association only
after successful existing-thread admission under that worker's current exact
placement. Preserve its native thread and history. This bridges existing sessions
before loss; it is not a blanket metadata backfill.

**Already-lost, unassociated bindings remain unsupported for automatic native
replacement under this contract.** Preserve binding, available history/workspace,
and failure evidence; report the missing predecessor association. Never silently
label these sessions recovered or reset them. A verified private backup restoring
the original native home is a distinct restore contract requiring independent
owner and content proof.

## Persistence, update, and rollback decision

The placement column changes an authoritative persisted contract. Ship through
the canonical shared-database migration and schema admission owner, including
required schema metadata and the newer-reader fence. This design selects no
numeric schema version and changes no live database.

Older binaries must refuse the upgraded store instead of silently dropping or
overwriting lineage. An additive column alone is insufficient: old placement
writers do not maintain its lifecycle, and old binding codecs may strip ownership
fields when rewriting bindings. Update admission must cover this combined storage
contract before recovery is enabled.

Migration initializes old placement rows to null and leaves legacy binding
associations absent. It cannot manufacture historic owner facts. New-version
reopen preserves lineage and receipts. Migration rewrites no transcript/native
thread bytes.

Rollback uses the canonical verified pre-upgrade backup and matching binary under
exclusive stopped custody. Never decrement headers, drop the column, strip binding
fields, or admit an old writer to upgraded state. Post-upgrade changes follow the
existing backup rollback limitation; the operator must explicitly choose that loss.

## Implementation slices and required proof

1. Add canonical migration/admission fence, placement codec, and lifecycle
   postimage propagation. Prove old-store migration, new-store reopen,
   older-reader refusal, null legacy facts, and pending-effect denials.
2. Associate private bindings at creation and successful resume. Prove ordinary
   same-thread resume associates without rotation, while stale placement and
   protected native ownership cannot acquire a misleading association.
3. Join confirmed-loss admission, provisional history seed, and expected-binding
   replacement. Reuse existing owners. Prove normal dispatch composition rather
   than an injected service create.
4. Qualify source and canonical review, then separately coordinate immutable
   runtime/export and disposable lifecycle acceptance. Source design approval
   alone does not authorize a release or live fault.

Focused regressions cover same-session loss/replacement; seed before current
input; no old-input/tool replay; new thread with partial-recovery outcome;
failure before commit; restart after commit. Preserve denials for Stopped or
unconfirmed loss, wrong owner/generation, pending result/journal/move, revoked
claim, unrelated/unassociated binding, attestation, overflow, and protected native
ownership. Existing intact-disk Stop/restart must still resume the same thread.

Until those gates pass, generic missing-worker hydration and intact-disk native
continuation remain separate evidence, not native disk-loss recovery proof.

## Related contracts

- [Cloud worker session lifecycle](/gateway/cloud-workers/session-lifecycle)
- [Worker runtime setup](/gateway/cloud-workers/setup-and-bundle-installation)
- [Database ownership and schemas](/reference/database-schemas)
- [Integrity and downgrade recovery](/reference/database-schemas/integrity-and-recovery)
