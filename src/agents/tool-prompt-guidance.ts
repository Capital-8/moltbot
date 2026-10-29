/** Owns tool-gated system-prompt guidance for core and plugin tools. */
import { requireActivePluginRegistry } from "../plugins/runtime.js";
import {
  buildSkillWorkshopPromptSection,
  SKILL_WORKSHOP_TOOL_NAME,
} from "./skill-workshop-prompt.js";

const CORE_TOOL_PROMPT_GUIDANCE: ReadonlyArray<{ toolName: string; guidance: () => string }> = [
  {
    toolName: SKILL_WORKSHOP_TOOL_NAME,
    guidance: () => buildSkillWorkshopPromptSection().join("\n").trim(),
  },
];

const normalizeToolName = (name: string) => name.trim().toLowerCase();

/**
 * Guidance sections for the tools callable in this run, core tools first, then plugin
 * registrations by plugin id. Pass every callable name, deferred ones included: a tool
 * found through Tool Search still needs its guidance, and a denied tool adds nothing.
 */
export function listToolPromptGuidance(callableToolNames: Iterable<string>): string[] {
  const callable = new Set(Array.from(callableToolNames, normalizeToolName));
  if (callable.size === 0) {
    return [];
  }
  const sections = new Set<string>();
  for (const entry of CORE_TOOL_PROMPT_GUIDANCE) {
    if (callable.has(entry.toolName)) {
      sections.add(entry.guidance());
    }
  }
  // Plugin load order can differ between runs; only ownership may order prompt bytes.
  const pluginEntries = requireActivePluginRegistry()
    .tools.flatMap(({ pluginId, names, promptGuidance }) =>
      promptGuidance && names.some((name) => callable.has(normalizeToolName(name)))
        ? [{ key: `${pluginId}\u0000${names[0] ?? ""}`, promptGuidance }]
        : [],
    )
    .toSorted((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  for (const entry of pluginEntries) {
    sections.add(entry.promptGuidance);
  }
  return [...sections];
}
