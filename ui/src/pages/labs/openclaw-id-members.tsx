import { createSignal, For, Show } from "solid-js";
import {
  formatEd25519PublicKey,
  signStatement,
  type SignedStatement,
} from "../../../../packages/openclaw-id-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { SettingsRow } from "../../components/solid/settings-ui.tsx";
import { formatUiError } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { loadOwnerDeviceSigner } from "./openclaw-id-device-key.ts";
import type { OpenClawIdStatusResult } from "./openclaw-id-types.ts";

/**
 * Members of a linked claw. Removing one signs a MembershipChange with this
 * browser's owner device key and sends it directly to the Gateway, which cuts
 * the member's tunnel access, sessions, tokens and runs.
 */
export function OpenClawIdMembers(props: {
  client: GatewayBrowserClient | null;
  link: OpenClawIdStatusResult["link"];
  onChanged: () => void;
}) {
  const [busy, setBusy] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const remove = async (accountId: string) => {
    const client = props.client;
    const clawId = props.link.clawId;
    if (!client || !clawId) {
      return;
    }
    setBusy(accountId);
    setError(null);
    try {
      const signer = await loadOwnerDeviceSigner(clawId);
      const devicePub = signer ? formatEd25519PublicKey(signer.publicKey) : undefined;
      const own = props.link.ownerDevices?.find((device) => device.devicePub === devicePub);
      if (!signer || !own) {
        throw new Error(t("labsPage.openclawId.noOwnerKey"));
      }
      const statement = await signStatement(
        "MembershipChange",
        {
          claw_id: clawId,
          seq: (props.link.seq ?? 0) + 1,
          target: { op: "remove", account_id: accountId },
          issued_at: Math.floor(Date.now() / 1000),
        },
        signer,
        [own.cert as SignedStatement<"OwnerDeviceCert">],
      );
      await client.request("openclawId.authority", { action: "submit", statement });
      props.onChanged();
    } catch (failure) {
      setError(formatUiError(failure));
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <For each={props.link.members ?? []}>
        {(member) => (
          <SettingsRow
            nested
            title={member.accountId}
            description={t("labsPage.openclawId.memberDescription", {
              role: member.role,
              devices: String(member.peerKeys.length),
            })}
            control={
              <button
                type="button"
                class="btn btn--sm danger"
                disabled={busy() !== null}
                onClick={() => void remove(member.accountId)}
              >
                {busy() === member.accountId
                  ? t("labsPage.openclawId.removing")
                  : t("labsPage.openclawId.remove")}
              </button>
            }
          />
        )}
      </For>
      <Show when={error()}>
        {(message) => (
          <SettingsRow
            nested
            title={t("labsPage.openclawId.removeFailed")}
            description={<span role="alert">{message()}</span>}
          />
        )}
      </Show>
    </>
  );
}
