import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, onTestFinished } from "vitest";
import { getCliProcessTestTimeout } from "../cli/cli-process-child.test-helpers.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { getOpenClawAgentMigrationSchema } from "../state/openclaw-agent-schema-history.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { stateMigrationSourceSchema } from "../state/openclaw-state-db-schema-source.js";
import { withLegacyPublicationDraft } from "../state/openclaw-state-db-schema-v28-publication.js";
import {
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
} from "../state/openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import {
  addPreCutoverClientCredentialTablesForTest,
  withStateMigrationBackupForTest,
} from "../state/openclaw-state-schema.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import {
  createSourceRuntime,
  runSourceRuntime,
} from "./doctor-config-preflight.process.test-support.js";

// A full source CLI upgrade includes original capture and two agent migrations.
const childTimeout = 90_000;
const agentIds = ["main", "worker"];

it.each(["initial28", "retry33", "unknown-drift"] as const)(
  "doctor --fix prepares shared state before agent migration (%s)",
  async (scenario) => {
    const port = await acquireTestPortBlock({ offsets: [0] });
    onTestFinished(port.release);
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      await state.writeConfig({
        gateway: { mode: "local", port: port.port, controlUi: { enabled: false } },
        agents: {
          ownership: "explicit",
          entries: { main: { workspace: state.workspaceDir }, worker: {} },
        },
        plugins: { enabled: false },
      });
      const sharedPath = state.statePath("state", "openclaw.sqlite");
      fs.mkdirSync(path.dirname(sharedPath), { recursive: true });
      {
        using db = new DatabaseSync(sharedPath);
        // The retained predecessor published v28 without draft and kept the old
        // lease-owner index. A failed version phase leaves those shapes at v33.
        db.exec(
          stateMigrationSourceSchema(
            withLegacyPublicationDraft(OPENCLAW_STATE_SCHEMA_SQL),
            28,
          ).replace("ON state_leases(owner);", "ON state_leases(owner, updated_at DESC);"),
        );
        addPreCutoverClientCredentialTablesForTest(db);
        db.exec(`PRAGMA user_version=28;
          INSERT INTO schema_meta(meta_key,role,schema_version,created_at,updated_at)
          VALUES ('primary','global',28,1,1);
          INSERT INTO github_publication_requests (
            request_id, idempotency_key, request_digest, session_id, session_key, agent_id,
            worktree_id, repository_fingerprint, identity_source, identity_account_id,
            identity_login, status, branch, created_at_ms, updated_at_ms, pull_request_url
          ) VALUES ('retained', 'retained', 'digest', 'session', 'agent:main:retained', 'main',
            'worktree', 'repository', 'system-detected', 1, 'synthetic', 'published', 'branch',
            1, 1, 'https://example.invalid/pull/1');`);
      }
      if (scenario !== "initial28") {
        // Reproduce the committed version phase, including its local-credential
        // cutover, rather than inventing a v33 store by changing version markers.
        await withStateMigrationBackupForTest({ env: state.env, path: sharedPath }, () => {
          expect(
            repairOpenClawStateDatabaseSchema({
              env: state.env,
              path: sharedPath,
              versionMigrationOnly: true,
            }).warnings,
          ).toEqual([]);
        });
      }
      if (scenario === "unknown-drift") {
        using db = new DatabaseSync(sharedPath);
        db.exec("ALTER TABLE github_publication_requests RENAME COLUMN branch TO unknown_branch");
      }
      const agentPaths = agentIds.map((agentId) => {
        const pathname = state.statePath("agents", agentId, "agent", "openclaw-agent.sqlite");
        fs.mkdirSync(path.dirname(pathname), { recursive: true });
        using db = new DatabaseSync(pathname);
        db.exec(getOpenClawAgentMigrationSchema(28));
        db.exec("PRAGMA user_version=28");
        db.prepare(`INSERT INTO schema_meta
          (meta_key,role,schema_version,agent_id,created_at,updated_at)
          VALUES ('primary','agent',28,?,1,1)`).run(agentId);
        db.exec(`INSERT INTO cache_entries(scope,key,value_json,updated_at)
          VALUES ('retained','history','"preserved"',1);`);
        return pathname;
      });
      const runtime = createSourceRuntime(state.root);
      const env: NodeJS.ProcessEnv = {
        ...state.env,
        OPENCLAW_SERVICE_REPAIR_POLICY: "external",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_TEST_FAST: "1",
        OPENCLAW_NO_RESPAWN: "1",
        NO_COLOR: "1",
      };
      for (const key of ["NODE_ENV", "VITEST", "VITEST_POOL_ID", "VITEST_WORKER_ID"]) {
        delete env[key];
      }
      const result = await runSourceRuntime(
        runtime,
        env,
        [
          "--input-type=module",
          "--eval",
          // Keep CLI, maintenance, backups and migrations real; isolate only
          // unrelated provider/model/service health checks after those phases.
          String.raw`import { registerHooks } from "node:module";
           import path from "node:path";
           registerHooks({ resolve(specifier, context, nextResolve) {
             if (specifier.endsWith("/doctor-health-contributions.js")) {
               return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(
                 "export async function runDoctorHealthContributions() {}\n" +
                 "export async function resolveDoctorContributionHealthChecks() { return []; }") };
             }
             return nextResolve(specifier, context);
           }});
           process.argv = [process.execPath, path.resolve("src/entry.ts"), "doctor", "--fix",
             "--non-interactive", "--no-workspace-suggestions"];
           await import("./src/entry.ts");`,
        ],
        childTimeout,
      );
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.signal, output).toBeNull();
      expect(result.code, output).toBe(scenario === "unknown-drift" ? 1 : 0);
      using db = new DatabaseSync(sharedPath, { readOnly: true });
      expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(
        OPENCLAW_STATE_SCHEMA_VERSION,
      );
      expect(db.prepare("SELECT request_digest FROM github_publication_requests").all()).toEqual([
        { request_digest: "digest" },
      ]);
      expect(
        db
          .prepare("PRAGMA table_info(github_publication_requests)")
          .all()
          .some(({ name }) => name === "draft"),
      ).toBe(scenario !== "unknown-drift");
      for (const pathname of agentPaths) {
        using agent = new DatabaseSync(pathname, { readOnly: true });
        expect(agent.prepare("PRAGMA user_version").get()?.user_version).toBe(
          scenario === "unknown-drift" ? 28 : OPENCLAW_AGENT_SCHEMA_VERSION,
        );
        expect(
          agent.prepare("SELECT value_json FROM cache_entries WHERE scope='retained'").get(),
        ).toEqual({ value_json: '"preserved"' });
      }
      if (scenario === "unknown-drift") {
        expect(output).toMatch(/github_publication_requests|unrecognized schema/u);
      } else {
        expect(output).toContain("Doctor complete.");
        expect(
          openOpenClawStateDatabase({ env: state.env })
            .db.prepare("SELECT draft FROM github_publication_requests")
            .get(),
        ).toEqual({ draft: null });
        const backups = fs
          .readdirSync(path.dirname(sharedPath))
          .filter(
            (name) =>
              name.startsWith("openclaw.sqlite.pre-startup-migration-") &&
              name.endsWith(".bak") &&
              !name.endsWith(".scoped.bak"),
          );
        expect(backups.length).toBeGreaterThan(0);
        const original = backups.find((backupName) => {
          using saved = new DatabaseSync(path.join(path.dirname(sharedPath), backupName), {
            readOnly: true,
          });
          return (
            saved.prepare("PRAGMA user_version").get()?.user_version ===
              (scenario === "initial28" ? 28 : OPENCLAW_STATE_SCHEMA_VERSION) &&
            !saved
              .prepare("PRAGMA table_info(github_publication_requests)")
              .all()
              .some(({ name }) => name === "draft")
          );
        });
        expect(original).toBeDefined();
        using saved = new DatabaseSync(path.join(path.dirname(sharedPath), original!), {
          readOnly: true,
        });
        expect(
          saved.prepare("SELECT request_digest FROM github_publication_requests").get(),
        ).toEqual({ request_digest: "digest" });
      }
    });
  },
  getCliProcessTestTimeout(childTimeout),
);
