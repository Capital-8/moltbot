import { withLegacyStateHeadLayout } from "./openclaw-state-db-schema-v26-layout.js";
import { withLegacyStateWriteIndexes } from "./openclaw-state-db-schema-v27-indexes.js";
import { withLegacyLocalWorkspaceManifests } from "./openclaw-state-db-schema-v31-workspace-manifests.js";
import { withLegacyWorkerRetention } from "./openclaw-state-db-schema-v32-session-retention.js";
import { withLegacyDiskAuthority } from "./openclaw-state-db-schema-v33-disk-authority.js";

/** Exact historical inputs are also registered with the canonical schema catalog generator. */
export function stateMigrationSourceSchema(schema: string, previousVersion: number): string {
  const disk = previousVersion < 33 ? withLegacyDiskAuthority(schema) : schema;
  const retention = previousVersion < 32 ? withLegacyWorkerRetention(disk) : disk;
  const manifest = previousVersion < 31 ? withLegacyLocalWorkspaceManifests(retention) : retention;
  const indexes = previousVersion < 27 ? withLegacyStateWriteIndexes(manifest) : manifest;
  return previousVersion < 26 ? withLegacyStateHeadLayout(indexes) : indexes;
}
