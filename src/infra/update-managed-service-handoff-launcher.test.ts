import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";

const resolveExecutable = vi.hoisted(() => vi.fn(() => "/usr/bin/systemd-run"));
vi.mock("./executable-path.js", () => ({ resolveExecutableFromPathEnv: resolveExecutable }));

import {
  resolveSystemdHandoffLauncher,
  writeSystemdHandoffEnvironment,
} from "./update-managed-service-handoff-launcher.js";

const roots = createTempDirTracker();
afterEach(() => {
  roots.cleanup();
  vi.clearAllMocks();
});

describe("managed systemd handoff launcher", () => {
  it("runs updates in a manager-owned service outside the Gateway cgroup", () => {
    const directory = roots.make("handoff-launcher-");
    const environmentPath = path.join(directory, "handoff.env");
    const launcher = resolveSystemdHandoffLauncher({
      serviceEnv: { PATH: "/fixture/bin" },
      handoffId: "run-1",
      triage: false,
      directory,
      environmentPath,
      executable: "/usr/bin/node",
      args: ["handoff.cjs", "handoff.json"],
    });

    expect(launcher.unit).toBe("openclaw-update-run-1.service");
    expect(launcher.args).toEqual(
      expect.arrayContaining([
        "--pipe",
        "--wait",
        "--service-type=exec",
        "--slice=app-openclaw-update.slice",
        "--property=KillMode=control-group",
        "--property=OOMPolicy=stop",
        `--property=EnvironmentFile=${environmentPath}`,
        `--working-directory=${directory}`,
        "--unit=openclaw-update-run-1.service",
        "/usr/bin/node",
        "handoff.cjs",
        "handoff.json",
      ]),
    );
    expect(launcher.args).not.toContain("--scope");
  });

  it("keeps triage attached to the Gateway service", () => {
    const directory = roots.make("handoff-triage-");
    const launcher = resolveSystemdHandoffLauncher({
      serviceEnv: { PATH: "/fixture/bin", OPENCLAW_PROFILE: "fixture" },
      handoffId: "triage-1",
      triage: true,
      directory,
      environmentPath: path.join(directory, "handoff.env"),
      executable: "/usr/bin/node",
      args: ["handoff.cjs", "handoff.json"],
    });

    expect(launcher.unit).toBe("openclaw-triage-triage-1.scope");
    expect(launcher.args).toContain("--scope");
    expect(launcher.args).toContain("--property=PartOf=openclaw-gateway-fixture.service");
  });

  it("writes prepared environment bytes to a private file", async () => {
    const directory = roots.make("handoff-env-");
    const environmentPath = path.join(directory, "handoff.env");
    await writeSystemdHandoffEnvironment(environmentPath, {
      OPENCLAW_STATE_DIR: "/fixture/state dir",
      OPENCLAW_SECRET: "synthetic-secret",
      OMITTED: undefined,
    });

    const stat = await fs.stat(environmentPath);
    expect(stat.mode & 0o777).toBe(0o600);
    const content = await fs.readFile(environmentPath, "utf8");
    expect(content).toContain("OPENCLAW_STATE_DIR=");
    expect(content).toContain("OPENCLAW_SECRET=");
    expect(content).not.toContain("OMITTED");
  });
});
