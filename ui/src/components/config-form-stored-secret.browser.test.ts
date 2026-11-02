// Control UI tests cover replacing stored secrets, and the values that stay read-only.
import { describe, expect, it, vi } from "vitest";
import { configEnvReference } from "../lib/config-form-utils.ts";
import type { ConfigSecretFields } from "../lib/config/config-secret-fields.ts";
import { expectElement, renderTextInputFixture } from "../test-helpers/config-form-fixtures.tsx";
import { resolveConfigObjectFields } from "./config-form.node.collection.ts";
import type { JsonSchema } from "./config-form.shared.ts";

const REDACTED = "__OPENCLAW_REDACTED__";
const schema: JsonSchema = { type: "string" };
const path = ["channels", "telegram", "botToken"];
const hints = { "channels.telegram.botToken": { sensitive: true, label: "Bot Token" } };

function fakeSecretFields(envVar: string | null = null) {
  const held = new Map<string, string>();
  return {
    envVar: () => envVar,
    read: (target) => held.get(JSON.stringify(target)),
    hold: vi.fn((target, text) => void held.set(JSON.stringify(target), text)),
    release: vi.fn((target) => void held.delete(JSON.stringify(target))),
    save: vi.fn(async () => ({ ok: true as const })),
    subscribe: () => () => undefined,
  } satisfies ConfigSecretFields;
}

function render(params: {
  value: unknown;
  secretFields?: ConfigSecretFields;
  replace?: boolean;
  envVar?: string;
}) {
  const container = document.createElement("div");
  const onPatch = vi.fn();
  renderTextInputFixture(container, {
    schema,
    value: params.value,
    path,
    inputType: "text",
    hints,
    secretFields: params.secretFields,
    replaceStoredSecrets: params.replace ? { envVar: () => params.envVar ?? null } : undefined,
    onPatch,
  });
  const input = expectElement(container.querySelector<HTMLInputElement>("input"), "secret input");
  return { input, onPatch };
}

function type(input: HTMLInputElement, text: string) {
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.dispatchEvent(new FocusEvent("blur"));
}

describe("stored secrets", () => {
  it("stays read-only when nothing would own an explicit Save", () => {
    const { input } = render({ value: REDACTED });
    expect(input.readOnly).toBe(true);
  });

  it("holds a replacement without patching the shared draft", () => {
    const secretFields = fakeSecretFields();
    const { input, onPatch } = render({ value: REDACTED, secretFields });
    expect(input).toMatchObject({
      readOnly: false,
      value: "",
      type: "password",
      placeholder: "••••••••",
    });
    type(input, "new-token");
    expect(secretFields.hold).toHaveBeenCalledWith(path, "new-token", expect.anything());
    expect(onPatch).not.toHaveBeenCalled();
    type(input, "");
    expect(secretFields.release).toHaveBeenCalledWith(path);
    expect(onPatch).not.toHaveBeenCalled();
  });

  it("holds a redacted value the schema didn't mark", () => {
    const secretFields = fakeSecretFields();
    const container = document.createElement("div");
    const onPatch = vi.fn();
    renderTextInputFixture(container, {
      schema,
      value: REDACTED,
      path: ["other", "credential"],
      inputType: "text",
      hints: {},
      secretFields,
      onPatch,
    });
    const input = expectElement(container.querySelector<HTMLInputElement>("input"), "input");
    expect(input.readOnly).toBe(false);
    type(input, "new-token");
    expect(onPatch).not.toHaveBeenCalled();
  });

  it("lets a form with its own Save take the replacement as an edit", () => {
    const { input, onPatch } = render({ value: REDACTED, replace: true });
    expect(input.readOnly).toBe(false);
    type(input, "new-token");
    expect(onPatch).toHaveBeenCalledWith(path, "new-token");
  });

  it("keeps a SecretRef read-only and says why", () => {
    const secretFields = fakeSecretFields();
    const { input } = render({
      value: { source: "env", provider: "default", id: REDACTED },
      secretFields,
      replace: true,
    });
    expect(input.readOnly).toBe(true);
    expect(input.placeholder).toContain("SecretRef");
    type(input, "new-token");
    expect(secretFields.hold).not.toHaveBeenCalled();
  });

  it("keeps the parts of a SecretRef out of the replace flow", () => {
    const secretFields = fakeSecretFields();
    const { fields } = resolveConfigObjectFields({
      schema: {
        type: "object",
        properties: { id: { type: "string" }, provider: { type: "string" } },
      },
      value: { source: "env", provider: "default", id: REDACTED },
      path,
      hints,
      unsupported: new Set(),
      disabled: false,
      secretFields,
      replaceStoredSecrets: { envVar: () => null },
      onPatch: vi.fn(),
    });
    expect(fields.map((field) => field.secretFields)).toEqual([undefined, undefined]);
    expect(fields.map((field) => field.replaceStoredSecrets)).toEqual([undefined, undefined]);
  });

  it("keeps a value from the Gateway environment read-only and names it", () => {
    const secretFields = fakeSecretFields("TELEGRAM_TOKEN");
    const { input } = render({ value: REDACTED, secretFields });
    expect(input).toMatchObject({
      readOnly: true,
      value: "",
      placeholder: "From environment · TELEGRAM_TOKEN",
    });
    type(input, "new-token");
    expect(secretFields.hold).not.toHaveBeenCalled();

    const channels = render({ value: REDACTED, replace: true, envVar: "TELEGRAM_TOKEN" });
    expect(channels.input.readOnly).toBe(true);
    type(channels.input, "new-token");
    expect(channels.onPatch).not.toHaveBeenCalled();
  });

  it("reads the variable from the authored config", () => {
    const parsed = {
      channels: { telegram: { botToken: "${TELEGRAM_TOKEN}", webhookSecret: REDACTED } },
      list: [" ${LIST_TOKEN} "],
    };
    expect(configEnvReference(parsed, path)).toBe("TELEGRAM_TOKEN");
    expect(configEnvReference(parsed, ["list", 0])).toBe("LIST_TOKEN");
    expect(configEnvReference(parsed, ["channels", "telegram", "webhookSecret"])).toBeNull();
    expect(configEnvReference(parsed, ["channels", "discord", "token"])).toBeNull();
    expect(configEnvReference(undefined, path)).toBeNull();
  });

  it("shows an env placeholder instead of masking it", () => {
    const secretFields = fakeSecretFields();
    const { input } = render({ value: "${TELEGRAM_TOKEN}", secretFields });
    expect(input).toMatchObject({ readOnly: false, value: "${TELEGRAM_TOKEN}", type: "text" });
  });
});
