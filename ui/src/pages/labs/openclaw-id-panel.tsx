import { createMemo, createSignal, Errored, latest, Loading, Show } from "solid-js";
import {
  displayFingerprint,
  fingerprint,
  type PublicKeyText,
} from "../../../../packages/openclaw-id-protocol/src/index.ts";
import { SettingsRow, SettingsStatus, SettingsValue } from "../../components/solid/settings-ui.tsx";
import { formatUiError } from "../../lib/format-error.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { useGatewayPage } from "../../lib/reactive/gateway-page.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { showMakeReachableDialog } from "./openclaw-id-dialog.tsx";
import { OpenClawIdInvites } from "./openclaw-id-invites.tsx";
import { OpenClawIdMembers } from "./openclaw-id-members.tsx";
import type {
  OpenClawIdLinkPreparation,
  OpenClawIdStatusResult,
  OpenClawIdTunnelStatus,
} from "./openclaw-id-types.ts";

type StatusKind = "ok" | "warn" | "danger" | "accent" | "muted";

// One status line for the tunnel child.
function tunnelPresentation(status: OpenClawIdStatusResult["status"]): {
  kind: StatusKind;
  label: string;
} {
  if (status.state === "unconfigured") {
    return {
      kind: "warn",
      label: t("labsPage.openclawId.unconfigured", { keys: status.missing.join(", ") }),
    };
  }
  if (status.state === "failed") {
    return { kind: "danger", label: status.reason };
  }
  if (status.state === "off") {
    return { kind: "muted", label: t("labsPage.openclawId.off") };
  }
  const tunnel: OpenClawIdTunnelStatus = status.tunnel;
  switch (tunnel.state) {
    case "running":
      return tunnel.relayOnline
        ? {
            kind: "ok",
            label: t("labsPage.openclawId.running", { count: String(tunnel.connections) }),
          }
        : { kind: "warn", label: t("labsPage.openclawId.relayOffline") };
    case "starting":
      return { kind: "accent", label: t("labsPage.openclawId.starting") };
    case "backoff":
      return {
        kind: tunnel.crashLooping ? "danger" : "warn",
        label: t("labsPage.openclawId.restarting", { exit: tunnel.lastExit }),
      };
    case "unavailable":
      return { kind: "danger", label: tunnel.reason };
    default:
      return { kind: "muted", label: t("labsPage.openclawId.stopped") };
  }
}

// What to do about a tunnel problem, shown under its status; undefined when healthy.
function tunnelHint(status: OpenClawIdStatusResult["status"]): string | undefined {
  if (status.state !== "on") {
    return undefined;
  }
  const tunnel = status.tunnel;
  if (tunnel.state === "unavailable" && tunnel.retryInMs !== undefined) {
    return t("labsPage.openclawId.unavailableRetry");
  }
  return undefined;
}

async function shortFingerprint(key: string | undefined): Promise<string | undefined> {
  return key ? displayFingerprint(await fingerprint(key as PublicKeyText)) : undefined;
}

/** Remote access details and "Make reachable", nested under the Labs switch. */
export function OpenClawIdPanel() {
  const context = useApplication();
  const page = useGatewayPage({ getGateway: () => latest(() => context.gateway) });
  const [revision, setRevision] = createSignal(0);
  const [actionError, setActionError] = createSignal<string | null>(null);
  const read = createMemo(async () => {
    revision();
    const client = page.client;
    if (!client || !page.connected) {
      return undefined;
    }
    const result = await client.request<OpenClawIdStatusResult>("openclawId.status", {});
    return {
      ...result,
      serverFingerprint: await shortFingerprint(
        result.status.state === "on" && result.status.tunnel.state === "running"
          ? result.status.tunnel.endpointKey
          : undefined,
      ),
      rootFingerprint: await shortFingerprint(result.link.rootPub),
    };
  });
  const makeReachable = async () => {
    const client = page.client;
    if (!client) {
      return;
    }
    setActionError(null);
    try {
      const preparation = await client.request<OpenClawIdLinkPreparation>("openclawId.authority", {
        action: "prepare",
      });
      await showMakeReachableDialog({ client, preparation });
    } catch (error) {
      setActionError(formatUiError(error));
    } finally {
      setRevision((value) => value + 1);
    }
  };

  const [enrollmentCode, setEnrollmentCode] = createSignal("");
  const publish = async () => {
    const client = page.client;
    if (!client) {
      return;
    }
    setActionError(null);
    try {
      await client.request("openclawId.authority", {
        action: "publish",
        enrollmentCode: enrollmentCode().trim() || undefined,
      });
      setEnrollmentCode("");
    } catch (error) {
      setActionError(formatUiError(error));
    } finally {
      setRevision((value) => value + 1);
    }
  };

  return (
    <Errored
      fallback={(error) => (
        <SettingsRow
          nested
          title={t("labsPage.openclawId.statusTitle")}
          description={<span role="alert">{formatUiError(error())}</span>}
        />
      )}
    >
      <Loading on={revision()}>
        <Show when={read()}>
          {(state) => {
            const tunnel = () => tunnelPresentation(state().status);
            const canLink = () =>
              state().channel === "local_operator" &&
              state().status.state === "on" &&
              !state().link.linked &&
              Boolean(state().services.loaderDomain);
            return (
              <>
                <SettingsRow
                  nested
                  title={t("labsPage.openclawId.tunnelTitle")}
                  description={
                    <Show
                      when={tunnelHint(state().status)}
                      fallback={
                        <Show when={state().serverFingerprint}>
                          {(fp) => t("labsPage.openclawId.serverKey", { fingerprint: fp() })}
                        </Show>
                      }
                    >
                      {(hint) => hint()}
                    </Show>
                  }
                  control={<SettingsStatus kind={tunnel().kind} label={tunnel().label} />}
                />
                <Show
                  when={state().link.linked}
                  fallback={
                    <SettingsRow
                      nested
                      title={t("labsPage.openclawId.notLinkedTitle")}
                      description={
                        state().channel === "local_operator"
                          ? state().services.loaderDomain
                            ? t("labsPage.openclawId.notLinkedDescription")
                            : t("labsPage.openclawId.needsLoaderDomain")
                          : t("labsPage.openclawId.localOnly")
                      }
                      control={
                        <button
                          type="button"
                          class="btn primary btn--sm"
                          disabled={!canLink()}
                          onClick={() => void makeReachable()}
                        >
                          {t("labsPage.openclawId.makeReachable")}
                        </button>
                      }
                    />
                  }
                >
                  <SettingsRow
                    nested
                    title={t("labsPage.openclawId.reachableTitle")}
                    description={t("labsPage.openclawId.reachableDescription", {
                      owners: String(state().link.ownerDevices?.length ?? 0),
                      members: String(state().link.members?.length ?? 0),
                    })}
                    control={
                      <SettingsValue mono value={`https://${state().link.hostname ?? ""}`} />
                    }
                  />
                  <SettingsRow
                    nested
                    title={t("labsPage.openclawId.ownerTitle")}
                    description={t("labsPage.openclawId.ownerDescription")}
                    control={<SettingsValue mono value={state().rootFingerprint ?? "—"} />}
                  />
                  <SettingsRow
                    nested
                    title={t("labsPage.openclawId.discoveryTitle")}
                    description={
                      state().link.publication?.state === "failed"
                        ? (state().link.publication as { message: string }).message
                        : state().link.publication?.state === "published"
                          ? undefined
                          : t("labsPage.openclawId.enrollmentCodeHint")
                    }
                    control={
                      <Show
                        when={state().link.publication?.state !== "published"}
                        fallback={
                          <SettingsStatus
                            kind="ok"
                            label={t("labsPage.openclawId.publication.published")}
                          />
                        }
                      >
                        <input
                          class="settings-input"
                          type="text"
                          aria-label={t("labsPage.openclawId.enrollmentCode")}
                          placeholder={t("labsPage.openclawId.enrollmentCodePlaceholder")}
                          autocomplete="off"
                          spellcheck="false"
                          value={enrollmentCode()}
                          onInput={(event) => setEnrollmentCode(event.currentTarget.value)}
                        />
                        <button type="button" class="btn btn--sm" onClick={() => void publish()}>
                          {t("labsPage.openclawId.publish")}
                        </button>
                      </Show>
                    }
                  />
                  <OpenClawIdInvites
                    client={page.client}
                    link={state().link}
                    onChanged={() => setRevision((value) => value + 1)}
                  />
                  <OpenClawIdMembers
                    client={page.client}
                    link={state().link}
                    onChanged={() => setRevision((value) => value + 1)}
                  />
                </Show>
                <Show when={actionError()}>
                  {(message) => (
                    <SettingsRow
                      nested
                      title={t("labsPage.openclawId.actionFailed")}
                      description={<span role="alert">{message()}</span>}
                    />
                  )}
                </Show>
              </>
            );
          }}
        </Show>
      </Loading>
    </Errored>
  );
}
