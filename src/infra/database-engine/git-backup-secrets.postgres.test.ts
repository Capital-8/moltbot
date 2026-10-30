import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createGitBackupRowTransform } from "../../snapshot/git-backup-sanitizer.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { materializeDatabasePort, type PortDescriptor } from "./port.worker.js";
import { expectedPostgresCatalog } from "./postgres-catalog.js";

const configured = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;
const dirs = useAutoCleanupTempDirTracker(afterEach);
const secret = "synthetic-secret-must-not-appear-in-export";

const metadata = {
  schema: "git_backup_secret_fixture",
  tables: [
    {
      name: "plugin_state_entries",
      columns: [
        { name: "plugin_id", type: "text", nullable: false, identity: false, default: null },
        { name: "namespace", type: "text", nullable: false, identity: false, default: null },
        { name: "entry_key", type: "text", nullable: false, identity: false, default: null },
        { name: "value_json", type: "text", nullable: false, identity: false, default: null },
        { name: "created_at", type: "bigint", nullable: false, identity: false, default: null },
      ],
      pk: ["plugin_id", "namespace", "entry_key"],
      unique: [],
      foreignKeys: [],
      indexes: 1,
      identities: [],
    },
  ],
  objects: [],
};
const descriptor: PortDescriptor = {
  ...metadata,
  id: "state",
  version: 1,
  minimumPostgresVersion: 16,
  sqlite: `CREATE TABLE plugin_state_entries (
    plugin_id TEXT NOT NULL,
    namespace TEXT NOT NULL,
    entry_key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (plugin_id, namespace, entry_key)
  ) STRICT`,
  preData: `CREATE TABLE plugin_state_entries (
    plugin_id TEXT NOT NULL,
    namespace TEXT NOT NULL,
    entry_key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (plugin_id, namespace, entry_key)
  )`,
  postData: "",
  expectedCatalog: expectedPostgresCatalog(metadata),
};

describe.skipIf(!connection)("PostgreSQL Git backup secret exclusion", () => {
  it("redacts credential rows before portable image materialization", async () => {
    const directory = dirs.make("git-backup-postgres-secrets-");
    const sourcePath = `${directory}/source.sqlite`;
    const imagePath = `${directory}/image.sqlite`;
    const namespace = `git_backup_secrets_${randomUUID().replaceAll("-", "")}`;
    const storeId = randomUUID();
    using source = openNodeSqliteDatabase(sourcePath);
    source.exec(descriptor.sqlite);
    const insert = source.prepare("INSERT INTO plugin_state_entries VALUES (?, ?, ?, ?, 1)");
    insert.run("zalouser", "credentials", "default", JSON.stringify({ cookie: secret }));
    insert.run(
      "discord",
      "thread-bindings",
      "thread",
      JSON.stringify({ threadId: "thread", webhookToken: secret }),
    );
    insert.run("active-memory", "session-toggles", "session", JSON.stringify({ disabled: true }));

    const client = new Client({ connectionString: connection });
    await client.connect();
    try {
      await materializeDatabasePort({
        source: { engine: "sqlite", db: source },
        destination: { engine: "postgres", db: client, namespace },
        descriptor,
        storeId,
        assertCurrent() {},
      });

      using image = openNodeSqliteDatabase(imagePath, { readBigInts: true });
      await materializeDatabasePort({
        source: { engine: "postgres", db: client, namespace },
        destination: { engine: "sqlite", db: image },
        descriptor,
        storeId,
        assertCurrent() {},
        transformRow: createGitBackupRowTransform(
          { role: "global" },
          "state",
          new Set(["plugin_state_entries"]),
        ),
      });

      expect(
        image
          .prepare("SELECT plugin_id, value_json FROM plugin_state_entries ORDER BY plugin_id")
          .all(),
      ).toEqual([
        { plugin_id: "active-memory", value_json: '{"disabled":true}' },
        { plugin_id: "discord", value_json: '{"threadId":"thread"}' },
      ]);
      expect((await fs.readFile(imagePath)).includes(Buffer.from(secret))).toBe(false);
      expect(
        (
          await client.query(
            `SELECT count(*)::int AS n FROM "${namespace}".plugin_state_entries WHERE value_json LIKE $1`,
            [`%${secret}%`],
          )
        ).rows,
      ).toEqual([{ n: 2 }]);
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await client.end();
    }
  });
});
