import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { applyParticleConfig } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

export default defineSingleProviderPluginEntry({
  id: "particle",
  name: "Particle Provider",
  description: "Particle model provider",
  manifest,
  provider: {
    label: "Particle",
    docsPath: "/providers/particle",
    manifestAuth: { applyConfig: applyParticleConfig },
    catalog: { discoveryMode: "strict" },
    ...buildProviderReplayFamilyHooks({ family: "openai-compatible" }),
    resolveThinkingProfile: () => ({
      levels: (["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const).map((id) => ({
        id,
      })),
      defaultLevel: "high",
    }),
  },
});
