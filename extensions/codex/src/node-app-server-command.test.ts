import { expect, it } from "vitest";
import { resolveCodexWorkerAppServerCommand } from "./node-app-server-command.js";

it("binds the admitted generic configuration version without a product-specific environment", () => {
  const version = "a".repeat(64);
  expect(
    resolveCodexWorkerAppServerCommand({ OPENCLAW_WORKER_CODEX_CONFIG_VERSION: version }),
  ).toBe(`codex.app-server.stdio.v1.${version}`);
  expect(resolveCodexWorkerAppServerCommand({})).toBe("codex.app-server.stdio.v1");
  expect(() => resolveCodexWorkerAppServerCommand({}, true)).toThrow("unavailable");
  expect(() =>
    resolveCodexWorkerAppServerCommand({ OPENCLAW_WORKER_CODEX_CONFIG_VERSION: "not-admitted" }),
  ).toThrow("invalid or mismatched");
});
