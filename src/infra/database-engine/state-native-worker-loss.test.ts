import { expect, it } from "vitest";
import { stateEngineSchema } from "../../state/openclaw-state-db-engine.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { loadStatePortDescriptor } from "./state-port-descriptor.js";

it.each([26, 27, 28, 31, 32])(
  "keeps exact shared-state v%s predecessor columns",
  async (version) => {
    const descriptor = await loadStatePortDescriptor(version);
    using source = openNodeSqliteDatabase(":memory:");
    source.exec(descriptor.sqlite);
    const placement = descriptor.tables.find((table) => table.name === "worker_session_placements");
    const environments = descriptor.tables.find((table) => table.name === "worker_environments");
    expect(
      placement?.columns.some((column) => column.name === "confirmed_loss_recovery_json"),
    ).toBe(version >= 32);
    expect(environments?.columns.some((column) => column.name === "session_retention_json")).toBe(
      version >= 32,
    );
    expect(descriptor.preData.includes('"confirmed_loss_recovery_json"')).toBe(version >= 32);
  },
);

it("binds the v32 PostgreSQL migration to its exact main v31 predecessor", () => {
  const migration = stateEngineSchema.postgresMigrations?.find((step) => step.version === 32);
  expect(migration?.fromSchema.postgres).not.toContain('"confirmed_loss_recovery_json"');
  expect(migration?.schema.postgres).toContain('"confirmed_loss_recovery_json"');
  expect(migration?.fromSchema.postgres).not.toContain('"session_retention_json"');
});
