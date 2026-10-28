import { describe, expect, it } from "vitest";
import type { ModelProviderConfig } from "../../config/types.models.js";
import { buildAgentHarnessSupportContext } from "../harness/support.js";
import { createModelAuthAvailabilityResolver } from "../model-auth-availability.js";
import { resolveApiKeyForProviderCore } from "../model-auth-provider.js";
import { nativeCommandAuthFixture, prepareAuthFixture } from "./prepare-auth.test-support.js";

describe("custom provider native command auth", () => {
  const fixture = nativeCommandAuthFixture();
  it.each(["model", "provider"] as const)(
    "admits only the declared %s runtime and endpoint",
    (scope) => {
      const { params, provider } = nativeCommandAuthFixture(scope);
      const resolver = createModelAuthAvailabilityResolver({
        cfg: params.config,
        authStore: params.authProfileStore,
        env: params.env,
        syntheticAuthProviderRefs: ["codex"],
      });
      const ref = {
        runtimeId: "codex",
        modelId: params.modelId,
        api: provider.api,
        baseUrl: provider.baseUrl,
      };
      expect(prepareAuthFixture(params).plan.credentialSource).toEqual({ kind: "none" });
      expect(resolver.evaluateRuntimeModelAuth(params.provider, ref).availability).toBe(true);
      for (const override of [
        { runtimeId: "openclaw" },
        { baseUrl: "https://other.example.test/v1" },
      ]) {
        expect(
          resolver.evaluateRuntimeModelAuth(params.provider, { ...ref, ...override }).availability,
        ).not.toBe(true);
      }
      expect(resolver.resolveProviderAuthAvailability(params.provider)).toBe(false);
    },
  );

  it("refuses host execution, owned provider IDs and direct credential access", async () => {
    const { params } = fixture;
    expect(() =>
      prepareAuthFixture({ ...params, harnessId: "openclaw", harnessRuntime: "openclaw" }),
    ).toThrow("explicit Codex");
    expect(
      buildAgentHarnessSupportContext({
        config: params.config,
        provider: params.provider,
        modelId: params.modelId,
        requestedRuntime: "codex",
        providerOwnership: { status: "owned", pluginIds: ["fixture"] },
      }).modelProvider?.nativeCommandAuth,
    ).toBeUndefined();
    await expect(
      resolveApiKeyForProviderCore({
        provider: params.provider,
        cfg: params.config,
        store: params.authProfileStore,
      }),
    ).rejects.toThrow("host credentials cannot be used");
  });

  it.each([
    { apiKey: "synthetic-key" },
    { api: "openai-completions" },
    { baseUrl: "http://inference.example.test/v1" },
    { baseUrl: "https://user:secret@inference.example.test/v1" },
    { headers: { "x-custom": "override" } },
    { request: { headers: { "x-custom": "override" } } },
    { authHeader: false },
    { timeoutSeconds: 15 },
    { models: [{ ...fixture.model, agentRuntime: undefined }] },
  ] satisfies Partial<ModelProviderConfig>[])(
    "rejects incompatible native route %j",
    (override) => {
      const { params, provider } = fixture;
      expect(() =>
        prepareAuthFixture({
          ...params,
          config: { models: { providers: { autodev: { ...provider, ...override } } } },
        }),
      ).toThrow("apiKey" in override ? "cannot be combined" : "Native command auth");
    },
  );
});
