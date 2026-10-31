import { createSignal, For, Show } from "solid-js";
import {
  buildInviteLink,
  bytesToBase64url,
  deriveInviteProofKey,
  fingerprint,
  formatEd25519PublicKey,
  generateInviteSecret,
  inviteSecretHash,
  PENDING_REDEMPTION_TTL_SECONDS,
  signStatement,
  type MemberRole,
  type MembershipTarget,
  type PublicKeyText,
  type SignedStatement,
  type StatementBodies,
  type StatementType,
} from "../../../../packages/openclaw-id-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { CopyButton } from "../../components/solid/copy-button.tsx";
import { SettingsSelect } from "../../components/solid/settings-select.tsx";
import { SettingsRow, SettingsStatus, SettingsValue } from "../../components/solid/settings-ui.tsx";
import { formatUiError } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { loadOwnerDeviceSigner } from "./openclaw-id-device-key.ts";
import type { OpenClawIdInvite, OpenClawIdStatusResult } from "./openclaw-id-types.ts";

type Link = OpenClawIdStatusResult["link"];

// Signs a statement with this browser's owner device key, chained to R by its own cert.
async function signAsOwner<T extends StatementType>(
  link: Link,
  type: T,
  body: StatementBodies[T],
): Promise<SignedStatement<T>> {
  const signer = link.clawId ? await loadOwnerDeviceSigner(link.clawId) : undefined;
  const devicePub = signer ? formatEd25519PublicKey(signer.publicKey) : undefined;
  const own = link.ownerDevices?.find((device) => device.devicePub === devicePub);
  if (!signer || !own) {
    throw new Error(t("labsPage.openclawId.invites.noOwnerKey"));
  }
  return signStatement(type, body, signer, [own.cert as SignedStatement<"OwnerDeviceCert">]);
}

// Signs a MembershipChange at the Gateway's next seq.
function signChange(link: Link, target: MembershipTarget) {
  return signAsOwner(link, "MembershipChange", {
    claw_id: link.clawId ?? "",
    seq: (link.seq ?? 0) + 1,
    target,
    issued_at: Math.floor(Date.now() / 1000),
  });
}

function formatDay(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * Creates the invite: a fresh link secret, its proof key, an InviteCap signed by
 * this owner device, and the link the owner shares. Only the cap and proof key go
 * to the Gateway; the secret stays in the link fragment.
 */
async function createInvite(
  client: GatewayBrowserClient,
  link: Link,
  email: string,
  role: MemberRole,
) {
  const now = Math.floor(Date.now() / 1000);
  const { invite_id, secret } = generateInviteSecret();
  const proofKey = await deriveInviteProofKey(secret);
  const cap = await signAsOwner(link, "InviteCap", {
    claw_id: link.clawId ?? "",
    invite_id,
    role,
    audience: { kind: "email", value: email },
    label: email,
    created_at: now,
    expires_at: now + PENDING_REDEMPTION_TTL_SECONDS,
    single_use: true,
    secret_hash: await inviteSecretHash(proofKey),
  });
  await client.request("openclawId.authority", {
    action: "register_invite",
    cap,
    proofKey: bytesToBase64url(proofKey),
  });
  const rootFp = await fingerprint(link.rootPub as PublicKeyText);
  return {
    email,
    url: buildInviteLink(link.hostname ?? "", { invite_id, secret, root_fp: rootFp }),
    expiresAt: now + PENDING_REDEMPTION_TTL_SECONDS,
  };
}

function PendingRequest(props: {
  invite: OpenClawIdInvite;
  busy: boolean;
  onDecide: (invite: OpenClawIdInvite, approve: boolean) => void;
}) {
  const pending = () => props.invite.pending!;
  const who = () =>
    pending().reported.displayName || pending().reported.email || pending().accountId;
  return (
    <SettingsRow
      nested
      title={t("labsPage.openclawId.invites.pendingTitle", {
        name: who(),
        role: props.invite.role,
      })}
      description={t("labsPage.openclawId.invites.pendingDescription", {
        email: pending().reported.email ?? pending().accountId,
        location:
          pending().reported.locationHint ?? t("labsPage.openclawId.invites.unknownLocation"),
        date: formatDay(pending().decideBy),
      })}
      control={
        <>
          <button
            type="button"
            class="btn btn--sm danger"
            disabled={props.busy}
            onClick={() => props.onDecide(props.invite, false)}
          >
            {t("labsPage.openclawId.invites.deny")}
          </button>
          <button
            type="button"
            class="btn primary btn--sm"
            disabled={props.busy}
            onClick={() => props.onDecide(props.invite, true)}
          >
            {t("labsPage.openclawId.invites.approve")}
          </button>
        </>
      }
    />
  );
}

/**
 * Invites for a linked claw (spec section 6.3): create an invite link, then
 * approve or deny the redemption the invitee sends. Approval and denial are
 * MembershipChanges this owner device signs and sends directly to the Gateway.
 */
export function OpenClawIdInvites(props: {
  client: GatewayBrowserClient | null;
  link: Link;
  onChanged: () => void;
}) {
  const [email, setEmail] = createSignal("");
  const [role, setRole] = createSignal<MemberRole>("operator");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [created, setCreated] = createSignal<Awaited<ReturnType<typeof createInvite>> | null>(null);
  const invites = () => props.link.invites ?? [];
  const pending = () => invites().filter((invite) => invite.status === "pending");
  const open = () => invites().filter((invite) => invite.status === "open");
  const validEmail = () => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email().trim());

  // Runs one owner action, then refreshes the panel.
  const run = async (action: (client: GatewayBrowserClient) => Promise<void>) => {
    const client = props.client;
    if (!client) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await action(client);
      props.onChanged();
    } catch (failure) {
      setError(formatUiError(failure));
    } finally {
      setBusy(false);
    }
  };

  const invite = async () => {
    const address = email().trim().toLowerCase();
    const granted = role();
    const link = props.link;
    await run(async (client) => {
      setCreated(await createInvite(client, link, address, granted));
      setEmail("");
    });
  };

  const decide = async (entry: OpenClawIdInvite, approve: boolean) => {
    const link = props.link;
    await run(async (client) => {
      const request = entry.pending!;
      const statement = await signChange(
        link,
        approve
          ? {
              op: "add",
              account_id: request.accountId,
              role: entry.role,
              peer_keys: [request.peerKey as `iroh:${string}`],
              invite_id: entry.inviteId,
            }
          : { op: "deny_invite", invite_id: entry.inviteId },
      );
      await client.request("openclawId.authority", { action: "submit", statement });
    });
  };

  return (
    <>
      <For each={pending()}>
        {(entry) => (
          <PendingRequest invite={entry} busy={busy()} onDecide={(i, a) => void decide(i, a)} />
        )}
      </For>
      <SettingsRow
        nested
        stacked
        title={t("labsPage.openclawId.invites.title")}
        description={t("labsPage.openclawId.invites.description")}
        control={
          <>
            <input
              class="settings-input"
              type="email"
              aria-label={t("labsPage.openclawId.invites.email")}
              placeholder={t("labsPage.openclawId.invites.emailPlaceholder")}
              autocomplete="off"
              spellcheck="false"
              value={email()}
              onInput={(event) => setEmail(event.currentTarget.value)}
            />
            <SettingsSelect
              aria-label={t("labsPage.openclawId.invites.role")}
              value={role()}
              options={[
                { value: "operator", label: t("labsPage.openclawId.invites.operator") },
                { value: "viewer", label: t("labsPage.openclawId.invites.viewer") },
              ]}
              onChange={(event) => setRole(event.currentTarget.value as MemberRole)}
            />
            <button
              type="button"
              class="btn primary btn--sm"
              disabled={busy() || !validEmail()}
              onClick={() => void invite()}
            >
              {t("labsPage.openclawId.invites.create")}
            </button>
          </>
        }
      />
      <Show when={created()}>
        {(made) => (
          <SettingsRow
            nested
            stacked
            title={t("labsPage.openclawId.invites.linkTitle", { email: made().email })}
            description={t("labsPage.openclawId.invites.linkDescription", {
              date: formatDay(made().expiresAt),
            })}
            control={
              <>
                <SettingsValue mono value={made().url} />
                <CopyButton text={made().url} idleLabel={t("labsPage.openclawId.invites.copy")} />
              </>
            }
          />
        )}
      </Show>
      <For each={open()}>
        {(entry) => (
          <SettingsRow
            nested
            title={entry.label}
            description={t("labsPage.openclawId.invites.openDescription", {
              role: entry.role,
              date: formatDay(entry.expiresAt),
            })}
            control={
              <SettingsStatus kind="muted" label={t("labsPage.openclawId.invites.waiting")} />
            }
          />
        )}
      </For>
      <Show when={error()}>
        {(message) => (
          <SettingsRow
            nested
            title={t("labsPage.openclawId.invites.failed")}
            description={<span role="alert">{message()}</span>}
          />
        )}
      </Show>
    </>
  );
}
