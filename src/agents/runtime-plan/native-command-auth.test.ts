import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createModelAuthAvailabilityResolver } from "../model-auth-availability.js";
import { prepareAuthFixture } from "./prepare-auth.test-support.js";

const provider = {
  auth: "native-command" as const,
  api: "openai-responses" as const,
  baseUrl: "https://inference.example.test/v1",
  models: [
    {
      id: "gpt-test",
      name: "Test model",
      reasoning: true,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100000,
      maxTokens: 1000,
      agentRuntime: { id: "codex" },
    },
  ],
};
const config: OpenClawConfig = { models: { providers: { autodev: provider } } };
const authProfileStore = { version: 1 as const, profiles: {} };
const params = {
  provider: "autodev",
  modelId: "gpt-test",
  config,
  env: { OPENAI_API_KEY: "synthetic-ambient-key" },
  authProfileStore,
  harnessId: "codex",
  harnessRuntime: "codex",
  harnessAuthBootstrap: "harness" as const,
};

describe("custom provider native command auth", () => {
  it("exposes only the declared Codex runtime without host credentials", () => {
    const resolver = createModelAuthAvailabilityResolver({
      cfg: config,
      authStore: authProfileStore,
      env: params.env,
      syntheticAuthProviderRefs: ["codex"],
    });
    const ref = {
      runtimeId: "codex",
      modelId: "gpt-test",
      api: provider.api,
      baseUrl: provider.baseUrl,
    };
    expect(resolver.evaluateRuntimeModelAuth("autodev", ref)).toMatchObject({
      availability: true,
      selectedAuthMode: "native-command",
      runtimeAuth: { id: "codex", source: "native" },
    });
    expect(
      resolver.evaluateRuntimeModelAuth("autodev", { ...ref, runtimeId: "openclaw" }).availability,
    ).not.toBe(true);
    expect(
      resolver.evaluateRuntimeModelAuth("autodev", {
        ...ref,
        baseUrl: "https://other.example.test/v1",
      }).availability,
    ).not.toBe(true);
  });

  it("prepares an implicit harness attempt without forwarding an ambient key", () => {
    const prepared = prepareAuthFixture(params);
    expect(prepared.attempts.map((attempt) => attempt.kind)).toEqual(["implicit"]);
    expect(prepared.plan.harnessAuthProvider).toBe("openai");
    expect(prepared.plan.forwardedAuthProfileId).toBeUndefined();
    expect(prepared.plan.credentialSource).toEqual({ kind: "none" });
  });

  it("refuses host execution and mixed declared credentials", () => {
    expect(() =>
      prepareAuthFixture({ ...params, harnessId: "openclaw", harnessRuntime: "openclaw" }),
    ).toThrow("explicit Codex");
    expect(() =>
      prepareAuthFixture({
        ...params,
        config: { models: { providers: { autodev: { ...provider, apiKey: "synthetic-key" } } } },
      }),
    ).toThrow("cannot be combined");
  });
});
