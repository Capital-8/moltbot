import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import type { CommandsListResult } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { registerProjectRegistry } from "../../projects/project-registry.js";
import { writeSkill } from "../../skills/test-support/e2e-test-helpers.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { commandsHandlers } from "./commands.js";
import { initializeRepository, withProjectState } from "./projects.test-support.js";

const CREATOR_SCOPES = ["operator.admin"];
const FIXTURE_SKILLS = new Set([
  "agent_fixture",
  "shared_fixture",
  "project_fixture",
  "project_agents_fixture",
  "unlisted_project_fixture",
]);

function putSkill(root: string, name: string, description = name) {
  return writeSkill({ dir: path.join(root, name), name, description });
}

async function listCommands(
  cfg: OpenClawConfig,
  params: Record<string, unknown>,
  scopes = CREATOR_SCOPES,
) {
  let result: { ok: boolean; payload?: unknown; error?: { code?: string } } | undefined;
  await commandsHandlers["commands.list"]!({
    req: {} as never,
    params: { agentId: "main", scope: "text", ...params },
    respond: (ok, payload, error) => {
      result = { ok, payload, error };
    },
    context: { getRuntimeConfig: () => cfg } as never,
    client: { connect: { scopes } } as never,
    isWebchatConnect: () => false,
  });
  return result!;
}

function fixtureSkills(result: { ok: boolean; payload?: unknown; error?: unknown }) {
  expect(result.error).toBeUndefined();
  return (result.payload as CommandsListResult).commands
    .filter((command) => FIXTURE_SKILLS.has(command.name))
    .map((command) => ({ name: command.name, description: command.description }));
}

test("New session command discovery previews admitted project skills under runtime rules", async () => {
  await withProjectState(async (state) => {
    const workspace = await initializeRepository(state.root, "workspace");
    const project = await initializeRepository(state.root, "project");
    await putSkill(path.join(workspace, "skills"), "agent-fixture");
    await putSkill(path.join(workspace, "skills"), "shared-fixture", "Agent copy");
    await putSkill(path.join(project, "skills"), "shared-fixture", "Project copy");
    await putSkill(path.join(project, "skills"), "project-fixture");
    await putSkill(path.join(project, ".agents", "skills"), "project-agents-fixture");
    await putSkill(path.join(project, "skills"), "unlisted-project-fixture");
    const registered = await registerProjectRegistry({ path: project });
    const bundled = path.join(state.root, "bundled");
    await fs.mkdir(bundled);
    const config = (mode: "off" | "all"): OpenClawConfig => ({
      plugins: { enabled: false },
      skills: { allowBundled: [] },
      agents: {
        entries: {
          main: {
            workspace,
            sandbox: { mode },
            skills: [
              "agent-fixture",
              "shared-fixture",
              "project-fixture",
              "project-agents-fixture",
            ],
          },
        },
      },
    });
    const cfg = config("off");
    const agentOnly = [
      { name: "agent_fixture", description: "agent-fixture" },
      { name: "shared_fixture", description: "Agent copy" },
    ];
    await withEnvAsync({ OPENCLAW_BUNDLED_SKILLS_DIR: bundled }, async () => {
      // No project keeps the existing agent-workspace catalog.
      expect(fixtureSkills(await listCommands(cfg, {}))).toEqual(agentOnly);
      // Both project roots join; the agent workspace keeps precedence and the allowlist holds.
      expect(fixtureSkills(await listCommands(cfg, { projectId: registered.id }))).toEqual([
        { name: "agent_fixture", description: "agent-fixture" },
        { name: "project_agents_fixture", description: "project-agents-fixture" },
        { name: "project_fixture", description: "project-fixture" },
        { name: "shared_fixture", description: "Agent copy" },
      ]);
      // Clients that could not create this session never read the project's skills.
      expect(
        fixtureSkills(await listCommands(cfg, { projectId: registered.id }, ["operator.read"])),
      ).toEqual(agentOnly);
      // Sandboxed agents cannot admit a project outside their workspace, so neither can discovery.
      expect(
        fixtureSkills(await listCommands(config("all"), { projectId: registered.id })),
      ).toEqual(agentOnly);
      expect(fixtureSkills(await listCommands(cfg, { projectId: "missing-project" }))).toEqual(
        agentOnly,
      );
      // An existing session owns its project; a client cannot redirect its catalog.
      expect(
        await listCommands(cfg, { projectId: registered.id, sessionKey: "agent:main:main" }),
      ).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    });
  });
});
