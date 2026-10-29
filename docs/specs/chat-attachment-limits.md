---
title: Chat attachment limits
summary: "Proposal to separate chat attachment admission limits from media-specific limits."
read_when:
  - Designing configurable per-file and per-message chat attachment limits
  - Separating document uploads from media processing budgets
---

# Chat attachment limits

Status: **proposal, not implemented**. The configuration keys below are not
currently supported. This document changes no runtime behavior, saved
configuration, upload transport, or permissions.

Related: [large Control UI uploads, #166757](https://github.com/openclaw/openclaw/issues/166757).
This proposes the configuration boundary for that discussion, not a competing
upload implementation or a claim to resolve the issue.

## Problem

An operator cannot set a chat document-upload budget independently of
`agents.defaults.mediaMaxMb`. A setting named for media currently also controls
non-media attachments, while transport and processing limits can reject a file
even when that setting allows it.

Separate three responsibilities:

- **Attachment admission:** how many file bytes a user may attach to one message.
- **Media handling:** image, audio, and video processing and generated-media budgets.
- **Transport:** how much encoded data a request can carry.

A larger attachment budget does not promise that a model can consume the file.

## Current behavior

Source inspected at `a9c067b23cdb52d375e68a139e317d26f4fc0421`:

- `src/gateway/chat-attachment-policy.ts` reads
  `agents.defaults.mediaMaxMb`, defaulting to 20 MiB, for decoded per-file
  admission. The advertised ceiling is clamped to the frame budget; images also
  face the agent-hydration ceiling.
- `src/gateway/server-methods/chat-send-attachments.ts` passes that setting to
  the attachment parser with non-image attachments enabled. It is not a
  media-only budget today.
- `src/gateway/payload-limits.ts` sets a 25 MiB WebSocket frame ceiling.
  `src/shared/chat-attachment-frame-budget.ts` reserves 256 KiB before
  accounting for Base64 expansion. The conservative decoded attachment budget
  is therefore 19,464,192 bytes, or 18.5625 MiB, for the whole batch. The exact
  serialized request must still fit.
- `ui/src/pages/chat/components/chat-attachment-admission.ts` already checks
  per-file limits and a frame-derived batch budget. There is no independent
  configurable decoded message-total limit in that policy.
- `src/media/configured-max-bytes.ts` also uses `mediaMaxMb` for generated
  media, outbound staging, and inbound staging capacity. Replacing only the
  chat policy reader would leave document staging coupled to media settings.

The [handshake contract](/gateway/protocol/handshake) explains existing
per-file advertising, encoded-frame validation, and reconnect-time refresh.
These observations concern repository behavior, not any server's saved settings.

## Proposed configuration and UI

Introduce a top-level `attachments` section for **inbound user chat attachments**:

| Configuration key        | UI label                                  | Meaning                                                   |
| ------------------------ | ----------------------------------------- | --------------------------------------------------------- |
| `attachments.maxFileMb`  | Maximum attachment size                   | Decoded bytes allowed for each file                       |
| `attachments.maxTotalMb` | Maximum total attachment size per message | Sum of decoded bytes across files attached to one message |

The UI must show the unit and explain that these limits cover files, including
images, audio, and video. Attachments are not synonymous with non-media files.
Use MiB (1,048,576 bytes) despite the existing `Mb` naming convention; do not
introduce a decimal/binary unit change with this separation.

For illustration only, not supported configuration or selected defaults:

```text
attachments.maxFileMb = 10
attachments.maxTotalMb = 15
```

Two 8 MiB documents would each pass the file limit but fail the 15 MiB total.
An image and a document share the same total budget; a filename or declared MIME
type must not bypass accounting. Text and JSON/Base64 overhead do not count
toward the decoded attachment total, but still count toward the wire limit.
Repeated attachment entries each count, even if their bytes are identical.

The target is to retain `agents.defaults.mediaMaxMb` for media-specific handling
only. For in-scope user-chat uploads, it must not remain a fallback for document
admission or staging once migration is complete. Media attachments still face
the general attachment limits plus applicable media-processing, hydration, and
provider limits. Raising this setting does not raise every image/provider ceiling.

A product-wide media-only claim also requires resolving the existing outbound
document readers and channel adapters. This first-stage inbound proposal does
not silently change their contracts. Maintainers must decide their attachment
policy and cutover before calling the setting media-only across OpenClaw.

### Scope and ownership

The initial contract covers the Gateway's user-chat attachment entrypoints:
`chat.send`, `sessions.send`, and session-creation initial turns, including
their Control UI and native clients. Both limits belong to one Gateway-owned
resolver, extending the existing chat attachment policy owner.

Do not silently make this a limit on terminal transfers, skill archives,
browser uploads, arbitrary filesystem tools, generated output, or every channel
plugin. Those have different owners and existing contracts. Channel/account
`mediaMaxMb` settings remain unchanged in this proposal; channel-wide attachment
policy would require explicit adapter adoption and separate review.

### Enforcement and errors

- Validate finite positive values with safe integer byte conversion. Accept
  fractional MiB only when the result is at least one byte; reject invalid or
  overflowing values instead of serializing an unusable policy.
- Recommend requiring `maxTotalMb >= maxFileMb` after defaults are resolved,
  rather than displaying a per-file setting the total can never permit.
- Count actual decoded file sizes before processing or durable acceptance.
  Preflight encoded lengths where possible to avoid allocating a whole
  rejected batch; do not trust client-reported sizes or Content-Length alone.
- Enforce the same aggregate rule server-side on every in-scope entrypoint.
  Browser checks are a convenience, not an authorization boundary.
- Reject the submitted message atomically on size failure before starting a
  model run; do not silently drop a file. Preserve the client's draft and name
  whether the failure was per-file, total, transport, or media-processing.
- Keep the upload-disable policy, access checks, MIME validation, cancellation,
  and cleanup under their existing owners.

Advertise resolved byte ceilings through the existing attachment policy, with
an additive aggregate field whose wire name needs protocol-owner review. Keep
existing `maxBytes` and `maxImageBytes` meanings for released clients. Older
clients may lack aggregate preflight, but server rejection must remain clear.
Preserve reconnect refresh initially; live refresh is separately tracked in
[#117552](https://github.com/openclaw/openclaw/issues/117552).

## Migration and rollout

Changing the meaning of a shipped setting without migration could unexpectedly
raise a document cap or reject documents that used to work. Recommended path:

1. Inventory every attachment, staging, and media reader of `mediaMaxMb`; classify
   each by responsibility before editing.
2. Preserve existing effective WebSocket admission on upgrade. Start from the
   current 20 MiB file default; choose a finite total default no lower than the
   current frame-derived batch budget. Exact defaults remain a product decision.
3. For an existing explicit `agents.defaults.mediaMaxMb`, use Doctor/config
   migration to materialize the equivalent attachment file limit when the new
   key is absent. Preserve an explicitly supplied new attachment limit and retain
   the existing media setting. Account for the chosen total default so it does
   not unintentionally tighten an admitted legacy file.
4. Make attachment admission and document staging consume the new owner together.
   Runtime code reads the canonical new keys, not a permanent legacy fallback.
5. Add schema, config UI labels/help, reload behavior, policy advertising, and
   all in-scope consumers together. Document downgrade behavior: an older binary
   may reject the new keys.

This PR does not select a retention policy, add a new upload-reference store,
or raise the WebSocket ceiling. Uploading files above that ceiling belongs to
the bounded streaming/upload-reference design in #166757, with its own
authorization, resource, cancellation, and cleanup decisions.

## Why not add this?

- **It may not solve the reported pain.** If the need is a 25 MiB PDF, two new
  settings still cannot move it through the current single-frame transport.
  The UI must not imply otherwise.
- **More knobs can mean less clarity.** Operators already face transport,
  media, extraction, and model budgets. Showing configured and effective limits
  with the binding constraint matters more than adding labels alone.
- **Top-level scope can overpromise.** A generic `attachments` name sounds
  universal. If maintainers require all-channel semantics immediately, scope
  this under a chat/Gateway namespace instead of shipping a misleading global
  promise. This proposal recommends the requested names with explicit chat scope.
- **Byte limits are not resource quotas.** Concurrent messages can exhaust
  memory or disk; small compressed documents can expand dramatically. Existing
  concurrency, extraction, pixel, duration, and retention budgets still matter.
- **Migration has lasting cost.** A media-only reinterpretation is useful only
  if all document callers move together and upgrades preserve operator intent.

The smaller alternative is clearer labels and errors around the existing
limits. Choose that if independent document and media budgets are not a real
operator requirement. Recommend the split when that independence is needed,
but do not present it as a large-file transport fix.

## Acceptance evidence required for implementation

- Boundary checks at exactly the file/total limits and one byte above them,
  including multiple individually valid files exceeding the total.
- Mixed media/document accounting, spoofed metadata, and direct RPC callers
  cannot bypass enforcement. Cover every in-scope entrypoint.
- Lowering the media budget does not lower document admission or staging; media
  processing and image/provider limits remain enforced independently.
- Latest-stable upgrade preserves legacy custom/default admission; explicit
  new values win migration, and invalid combinations get actionable errors.
- A real isolated Gateway/client flow proves accepted files reach the agent
  and rejected batches start no run, lose no draft, and leak no staged files.
- Old/new client policy handling, reconnect behavior, and encoded-frame
  rejection remain correct. UI implementation needs inspected before/after proof.

These are future implementation gates, not tests claimed by this design-only PR.
