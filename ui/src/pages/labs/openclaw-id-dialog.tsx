import "../../styles/secret-reveal.css";
import "./openclaw-id.css";
import { createSignal, Match, Show, Switch } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { withPromiseModalHost } from "../../components/promise-modal-host.ts";
import { CopyButton } from "../../components/solid/copy-button.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { formatUiError } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { generateOwnerDeviceKey, saveOwnerDeviceKey } from "./openclaw-id-device-key.ts";
import { createOpenClawIdCeremony, type OpenClawIdKit } from "./openclaw-id-link.ts";
import type { OpenClawIdLinkPreparation, OpenClawIdPublication } from "./openclaw-id-types.ts";

type Step =
  | { kind: "intro" }
  | { kind: "kit"; kit: OpenClawIdKit }
  | { kind: "linking" }
  | { kind: "done"; hostname: string; publication: OpenClawIdPublication | null }
  | { kind: "error"; message: string };

// Offers the kit as a text file so the owner can store it with their passwords.
function downloadKit(kit: OpenClawIdKit, hostname: string) {
  const text = [
    "OpenClaw recovery kit",
    "",
    `Kit: ${kit.text}`,
    `Owner fingerprint: ${kit.rootFingerprint}`,
    `First claw: https://${hostname}`,
    "",
    "Anyone with this kit can take ownership of your claws. Keep it private.",
    "",
  ].join("\n");
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "openclaw-recovery-kit.txt";
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * "Make reachable" (spec section 4): creates the recovery kit, blocks until the
 * owner confirms it is saved, signs the claw's binding with the kit's root and
 * hands only signed statements to the Gateway. Resolves true once linked.
 */
export function showMakeReachableDialog(params: {
  client: GatewayBrowserClient;
  preparation: OpenClawIdLinkPreparation;
}): Promise<boolean> {
  const ceremony = createOpenClawIdCeremony();
  return withPromiseModalHost<boolean>(undefined, (modal) => {
    modal.render(() => {
      const [step, setStep] = createSignal<Step>({ kind: "intro" });
      const [saved, setSaved] = createSignal(false);
      const [enrollmentCode, setEnrollmentCode] = createSignal("");
      const finish = (linked: boolean) => {
        ceremony.discard();
        modal.finish(linked);
      };
      const createKit = async () => {
        try {
          setStep({ kind: "kit", kit: await ceremony.createKit() });
        } catch (error) {
          setStep({ kind: "error", message: formatUiError(error) });
        }
      };
      const link = async () => {
        setStep({ kind: "linking" });
        try {
          const device = await generateOwnerDeviceKey();
          const statements = await ceremony.sign(
            params.preparation,
            device.signer,
            t("labsPage.openclawId.thisBrowser"),
          );
          // R is no longer needed once the statements are signed.
          ceremony.discard();
          const result = await params.client.request<{ publication: OpenClawIdPublication | null }>(
            "openclawId.link",
            {
              action: "commit",
              ...statements,
              enrollmentCode: enrollmentCode().trim() || undefined,
            },
          );
          await saveOwnerDeviceKey(params.preparation.claw_id, device.pair);
          setStep({
            kind: "done",
            hostname: params.preparation.hostname,
            publication: result.publication,
          });
        } catch (error) {
          ceremony.discard();
          setStep({ kind: "error", message: formatUiError(error) });
        }
      };
      const cancel = (event: Event) => {
        // The kit is shown once: closing before linking discards it, so confirm intent.
        if (step().kind === "linking") {
          event.preventDefault();
          return;
        }
        finish(step().kind === "done");
      };
      return (
        <openclaw-modal-dialog
          label={t("labsPage.openclawId.dialogTitle")}
          description={t("labsPage.openclawId.dialogDescription")}
          onModal-cancel={cancel}
        >
          <div class="exec-approval-card openclaw-id-dialog">
            <div class="secret-reveal__header">
              <Show when={step().kind === "done"}>
                <span class="secret-reveal__status" aria-hidden="true">
                  <Icon name="check" />
                </span>
              </Show>
              <div class="exec-approval-title">{t("labsPage.openclawId.dialogTitle")}</div>
            </div>
            <Switch>
              <Match when={step().kind === "intro"}>
                <div class="secret-reveal__body">
                  <p>{t("labsPage.openclawId.introBody", { host: params.preparation.hostname })}</p>
                  <p>{t("labsPage.openclawId.introKit")}</p>
                </div>
                <openclaw-modal-actions class="exec-approval-actions">
                  <button type="button" class="btn" onClick={() => finish(false)}>
                    {t("common.cancel")}
                  </button>
                  <button
                    type="button"
                    class="btn primary"
                    autofocus
                    onClick={() => void createKit()}
                  >
                    {t("labsPage.openclawId.createKit")}
                  </button>
                </openclaw-modal-actions>
              </Match>
              <Match when={step().kind === "kit" && (step() as Extract<Step, { kind: "kit" }>).kit}>
                {(kit) => (
                  <>
                    <div class="secret-reveal__body">
                      <p>{t("labsPage.openclawId.kitBody")}</p>
                    </div>
                    <div class="secret-reveal__value">
                      <code class="secret-reveal__code">{kit().text}</code>
                      <CopyButton text={kit().text} idleLabel={t("common.copy")} />
                    </div>
                    <p class="secret-reveal__note">
                      {t("labsPage.openclawId.kitFingerprint", {
                        fingerprint: kit().rootFingerprint,
                      })}
                    </p>
                    <div class="callout info secret-reveal__callout">
                      {t("labsPage.openclawId.kitWarning")}
                    </div>
                    <button
                      type="button"
                      class="btn btn--sm"
                      onClick={() => downloadKit(kit(), params.preparation.hostname)}
                    >
                      {t("labsPage.openclawId.downloadKit")}
                    </button>
                    <label class="settings-row settings-row--nested">
                      <span class="settings-row__text">
                        <span class="settings-row__title">
                          {t("labsPage.openclawId.enrollmentCode")}
                        </span>
                        <span class="settings-row__desc">
                          {t("labsPage.openclawId.enrollmentCodeHint")}
                        </span>
                      </span>
                      <input
                        class="settings-row__control"
                        type="text"
                        autocomplete="off"
                        spellcheck="false"
                        value={enrollmentCode()}
                        onInput={(event) => setEnrollmentCode(event.currentTarget.value)}
                      />
                    </label>
                    <label class="openclaw-id-dialog__confirm">
                      <input
                        type="checkbox"
                        checked={saved()}
                        onChange={(event) => setSaved(event.currentTarget.checked)}
                      />
                      <span>{t("labsPage.openclawId.kitSaved")}</span>
                    </label>
                    <openclaw-modal-actions class="exec-approval-actions">
                      <button type="button" class="btn" onClick={() => finish(false)}>
                        {t("common.cancel")}
                      </button>
                      <button
                        type="button"
                        class="btn primary"
                        disabled={!saved()}
                        onClick={() => void link()}
                      >
                        {t("labsPage.openclawId.makeReachable")}
                      </button>
                    </openclaw-modal-actions>
                  </>
                )}
              </Match>
              <Match when={step().kind === "linking"}>
                <div class="secret-reveal__body" role="status">
                  <p>{t("labsPage.openclawId.linking")}</p>
                </div>
              </Match>
              <Match when={step().kind === "done" && (step() as Extract<Step, { kind: "done" }>)}>
                {(done) => (
                  <>
                    <div class="secret-reveal__body">
                      <p>{t("labsPage.openclawId.doneBody", { host: done().hostname })}</p>
                      <Show when={done().publication?.state !== "published"}>
                        <p>{t("labsPage.openclawId.doneNotPublished")}</p>
                      </Show>
                    </div>
                    <openclaw-modal-actions class="exec-approval-actions">
                      <button
                        type="button"
                        class="btn primary"
                        autofocus
                        onClick={() => finish(true)}
                      >
                        {t("labsPage.openclawId.done")}
                      </button>
                    </openclaw-modal-actions>
                  </>
                )}
              </Match>
              <Match when={step().kind === "error" && (step() as Extract<Step, { kind: "error" }>)}>
                {(failed) => (
                  <>
                    <div class="callout danger" role="alert">
                      {failed().message}
                    </div>
                    <openclaw-modal-actions class="exec-approval-actions">
                      <button type="button" class="btn" autofocus onClick={() => finish(false)}>
                        {t("common.close")}
                      </button>
                    </openclaw-modal-actions>
                  </>
                )}
              </Match>
            </Switch>
          </div>
        </openclaw-modal-dialog>
      );
    });
  });
}
