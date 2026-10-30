---
title: "Authenticated profile audience proposal"
summary: "Proposed separation of authenticated profile ownership, session personalization, and audience-safe delivery"
read_when:
  - Reviewing personal instructions in collaborative conversations
  - Defining person-scoped Knowledge and history access
---

# Authenticated profile audience proposal

**Status: proposed, not implemented or accepted.** This document requests owner
decisions before changes to disclosure, permissions, or public plugin contracts.
It does not establish a new security guarantee or complete
[#186068](https://github.com/openclaw/openclaw/issues/186068).

## Existing foundation

Reuse the [human profile and personal USER.md owners](/concepts/user-model).
Authenticated members already have self-service profile editing, including
session-scoped access ([#179924](https://github.com/openclaw/openclaw/pull/179924),
[#184980](https://github.com/openclaw/openclaw/pull/184980)). Personal instructions
remain in the configured agent workspace, not the task worktree. The workspace-root
USER.md remains shared defaults. No second writable profile registry is proposed.

Preserve the current selection: assigned human owner first, otherwise authenticated
human creator. The authenticated requester independently determines the editor and
execution permissions. Another sender must not silently replace session selection.

[#186455](https://github.com/openclaw/openclaw/pull/186455) adds conversation grants
to an **agent-private** Knowledge partition. Reuse that capability without treating
the agent-private partition or the existing owner-private memory audience as
authenticated-person isolation.

## Proposed first-stage behavior

### Separate selection from admission

The host would admit a selected personal overlay only when it can establish that
the conversation's intended human audience is that canonical person. The host
must define this using existing identity and session sharing/access owners, not
names, model-supplied IDs, or a direct-looking session key. Trusted administrators
and host access remain outside any hostile-tenant secrecy claim.

Groups, channels, publicly shared or collaborative sessions, mixed-person batches,
and unverifiable audiences would receive shared defaults only in this first stage.
The selected profile would stay recorded when its overlay is withheld.

| Conversation                           | Selected profile              | Proposed personal context                                                    |
| -------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------- |
| Alice's person-private conversation    | Alice                         | Shared defaults, then Alice, after live admission                            |
| Bob's person-private conversation      | Bob                           | Shared defaults, then Bob, after live admission                              |
| Alice-assigned task shared with Bob    | Alice, unchanged              | Shared defaults only; do not substitute Bob                                  |
| Group or channel, regardless of sender | Existing selection, unchanged | Shared defaults only                                                         |
| Missing or unresolved audience         | Existing selection, if any    | No personal overlay                                                          |
| Internal continuation                  | Existing selection            | Only if retained host authority still establishes the same admitted audience |
| Delegated agent                        | Existing subagent policy      | No personal USER.md, as today                                                |

Recognizing Bob would use host-verified per-turn requester facts. Preferences Bob
explicitly expresses in the shared conversation could guide that response without
reading his private file or replacing session selection. This proposal does not
add field-level sharing or a second store for shareable preferences.

Audience changes must invalidate retained personal context through its existing
owner. Preserve prompt-prefix stability: requester facts belong to the current
turn; do not rewrite earlier prompts or history. If a harness cannot withdraw
previous context safely, it is not qualified for that transition.

### Include personal-tool results in the boundary

The authenticated Settings editor would retain its existing self-scoped file API,
role/agent ceilings, canonical identity resolution, content-hash conflict detection,
safe-file rules, and final-write authority checks. Its response goes to that
person's editor rather than the shared transcript.

The chat tool is a different delivery path: `personal_instructions` with action
`get` returns profile content, and `set` returns the saved content. Either can expose instructions
through shared tool history even if bootstrap is filtered.

The proposed first stage would allow these chat operations only when their
response has person-private admission for the authenticated editor. Shared or
unqualified turns would direct the person to the existing Settings editor instead
of reading their file into the conversation. Asking for a self-edit would not
implicitly consent to publishing the whole file.

**This narrows existing chat behavior and requires host/profile-owner agreement.**
Keep the canonical editor and stable tool schema; use the execution/admission
owner for current disclosure checks. Do not introduce another authentication or
confirmation-token protocol.

### Keep Knowledge and history with their owners

Knowledge would consume host-issued person/audience authority separately from the
session-selected profile. Reads would compose that person's private material and
explicitly admitted shared material, not silently acquire the entire agent-private
partition. Settle this dependency in
[#186067](https://github.com/openclaw/openclaw/issues/186067), not in a competing
profile or grant registry here.

Record, evidence, revision, and history IDs are locators, not grants. Denial must
cover restricted content and metadata, including titles, counts, cursors, graph
paths, automatic context, and cached results. Existing owners must check current
authority before releasing asynchronous results and after revocation or restart.

LosslessClaw would qualify ordinary history, explicit-ID expansion, delegated
expansion, compaction, and restart through supported APIs. Knowledge must not read
LCM's private database. Withholding a new overlay does not sanitize previously
delivered history. Its owner must define safe handling; no silent deletion,
history rewrite, or history-losing fork is proposed.

### Qualify capabilities, not just prompts

Start with one existing restricted Gateway/tool/mount configuration. Task
workspace operations may remain available, but enabled file, shell, native,
artifact, evidence, and history paths must not reach non-admitted personal roots.
A read-only mount is not a read-disclosure boundary, and a self-service API pass
does not certify generic file access.

Reuse sandbox, file-access, and harness owners. Do not add Knowledge-only path
filtering that other tools bypass. A combination unable to enforce the boundary
would remain unsupported for this privacy claim. No operating-system tenant
isolation from one shared Gateway is promised.

Inferred person views would remain attributable Knowledge records with their
evidence's restrictions. Scribes, recall, synthesis, and autonomous/delegated jobs
would receive no capability to promote them into USER.md. Explicit user-requested
self-edits would retain the canonical editor path; inferred records would not
override user-authored directives. Prompting an unrestricted file writer to comply
is not sufficient proof. All enabled mutation paths must satisfy this boundary.

## Owner decisions and implementation gate

1. **Host/profile and security owners:** accept or amend the person-private
   admission rule, intended-audience definition, overlay withholding, and narrowed
   shared-chat tool behavior.
2. **Host authority and Knowledge owners:** define person-private plus shared
   grants and revocation without equating agent-private grants with person privacy.
3. **LosslessClaw and harness owners:** define supported expansion and retained
   context-withdrawal paths, including already-delivered history.
4. **Filesystem/sandbox owners:** name the restricted tool/mount configuration
   that can actually enforce the claimed boundary.

Keep the
[#186065](https://github.com/openclaw/openclaw/issues/186065) →
[#186066](https://github.com/openclaw/openclaw/issues/186066) →
[#186067](https://github.com/openclaw/openclaw/issues/186067) →
[#186068](https://github.com/openclaw/openclaw/issues/186068) dependency chain open
until each scenario has qualifying evidence. Agreement on this document would not
itself prove prerequisite integration or authorize a merge or deployment. No new
schema, role, configuration, retention, or permission mechanism is implemented.

## Required qualification after agreement

Use real, separately authenticated Alice/Bob profiles in the existing registry,
their existing personal files, distinct private sentinels, shared defaults, an
explicitly admitted shared fact, both private conversations, and a shared task.

- Prove allowed self-edits and denied other-profile edits through Settings and
  the private chat tool separately, including conflicts, revocation, and merges.
- Prove the selection/admission matrix and shared-plus-selected ordering. Changing
  the sender or sharing a session must withhold content without selecting another
  person.
- Assert no denied content or metadata in shared bootstrap, tool results, replies,
  transcript views, and explicit/delegated history expansions. Test an allowed
  counterpart for every denied path.
- Prove person-private plus shared Knowledge separately from agent-private grants;
  repeat after revocation, restart, compaction, and retained-cache use.
- Exercise every enabled raw file/history/evidence path and automated USER.md
  mutation through the real owners. Prompt omission alone is not a privacy pass.
- Record each harness and operating system actually executed. Embedded, generic
  CLI, managed native, external native, delegated, ACP, realtime, remote worker,
  Linux, and Windows are separate claims; name unsupported and unexecuted paths.

Existing profile and partition regressions are baseline evidence only. They must
not be presented as a passing implementation of this proposed combined boundary.
