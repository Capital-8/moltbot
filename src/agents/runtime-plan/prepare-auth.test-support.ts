import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { prepareAgentRuntimeAuth } from "./prepare-auth.js";

const preparedMetadata = createPluginMetadataSnapshotFixture();

export function prepareAuthFixture(params: Parameters<typeof prepareAgentRuntimeAuth>[0]) {
  return prepareAgentRuntimeAuth({ metadataSnapshot: preparedMetadata, ...params });
}

/** Shared authored route for catalog and ordinary-selector composition. */
export function nativeCommandAuthFixture(scope: "model" | "provider" = "model") {
  const model = {
    id: "gpt-test",
    name: "Test model",
    reasoning: true,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100000,
    maxTokens: 1000,
    ...(scope === "model" ? { agentRuntime: { id: "codex" } } : {}),
  };
  const provider = {
    auth: "native-command" as const,
    api: "openai-responses" as const,
    baseUrl: "https://inference.example.test/v1",
    models: [model],
    ...(scope === "provider" ? { agentRuntime: { id: "codex" } } : {}),
  };
  return {
    model,
    provider,
    params: {
      provider: "autodev",
      modelId: model.id,
      config: { models: { providers: { autodev: provider } } },
      env: { OPENAI_API_KEY: "synthetic-ambient-key" },
      authProfileStore: {
        version: 1 as const,
        profiles: {
          "openai:decoy": {
            type: "api_key" as const,
            provider: "openai",
            key: "synthetic-profile-key",
          },
          "autodev:decoy": {
            type: "api_key" as const,
            provider: "autodev",
            key: "synthetic-custom-key",
          },
        },
      },
      harnessId: "codex",
      harnessRuntime: "codex",
      harnessAuthBootstrap: "harness" as const,
    },
  };
}
