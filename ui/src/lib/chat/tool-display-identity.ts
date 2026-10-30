import {
  defaultTitle,
  normalizeToolDisplayName,
} from "../../../../src/agents/tool-display-name.js";
import { resolveToolDisplayIcon } from "./tool-display-icon.ts";
import TOOL_DISPLAY_IDENTITY from "./tool-display-identity.generated.json" with { type: "json" };

const TOOL_MAP: Readonly<Record<string, { icon: string; label?: string }>> =
  TOOL_DISPLAY_IDENTITY.tools;

/** Labels and icons do not need the argument-detail parsers. */
export function resolveToolDisplayIdentity(toolName?: string) {
  const name = normalizeToolDisplayName(toolName);
  const key = name.toLowerCase();
  const spec = Object.hasOwn(TOOL_MAP, key) ? TOOL_MAP[key] : undefined;
  return {
    name,
    label: spec?.label ?? defaultTitle(name),
    icon: resolveToolDisplayIcon(name),
  };
}
