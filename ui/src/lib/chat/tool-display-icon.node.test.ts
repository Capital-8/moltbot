// @vitest-environment node

import { expect, it } from "vitest";
import SHARED_TOOL_DISPLAY_JSON from "../../../../apps/shared/OpenClawKit/Sources/OpenClawKit/Resources/tool-display.json" with { type: "json" };
import type { ToolDisplaySpec } from "../../../../src/agents/tool-display-common.js";
import { iconData } from "../../components/icon-data.ts";
import { resolveToolDisplayIdentity } from "./tool-display-identity.ts";

it("can render every shared tool icon, including the fallback", () => {
  for (const [name, spec] of Object.entries({
    fallback: SHARED_TOOL_DISPLAY_JSON.fallback,
    ...SHARED_TOOL_DISPLAY_JSON.tools,
  })) {
    expect(Object.hasOwn(iconData, spec.icon), `${name}: ${spec.icon}`).toBe(true);
  }
});

it("keeps compact identities aligned with the canonical tool catalog", () => {
  const tools: Record<string, ToolDisplaySpec & { icon: string }> = SHARED_TOOL_DISPLAY_JSON.tools;
  for (const [name, spec] of Object.entries(tools)) {
    expect(resolveToolDisplayIdentity(name), name).toEqual({
      name,
      label: spec.label ?? spec.title,
      icon: spec.icon,
    });
  }
});

it.each([
  [undefined, "tool", "Tool", "puzzle"],
  ["  ", "", "Tool", "puzzle"],
  ["constructor", "constructor", "Constructor", "puzzle"],
  ["__proto__", "__proto__", "Proto", "puzzle"],
  [" my_TOOL ", "my_TOOL", "My TOOL", "puzzle"],
  [" SHELL ", "SHELL", "SHELL", "squareTerminal"],
])("preserves compact identity for %s", (input, name, label, icon) => {
  expect(resolveToolDisplayIdentity(input)).toEqual({ name, label, icon });
});
