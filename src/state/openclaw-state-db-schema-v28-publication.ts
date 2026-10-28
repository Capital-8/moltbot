import type { DatabaseSync } from "node:sqlite";
import { ensureColumn, tableExists, tableHasColumn } from "./openclaw-state-db-schema-helpers.js";

const publicationDraftTables = [
  "github_publication_requests",
  "github_personal_publication_requests",
  "github_repository_publication_requests",
];

/** Published versions can outlive an interrupted or older-branch column cutover. */
export function needsPublicationDraftMigration(db: DatabaseSync): boolean {
  return publicationDraftTables.some(
    (table) => tableExists(db, table) && !tableHasColumn(db, table, "draft"),
  );
}

export const statePublicationDraftMigration = {
  version: 28,
  tables: publicationDraftTables,
  columns: publicationDraftTables.map((table) => `${table}.draft`),
  migrate: (db: DatabaseSync, _previousVersion: number): boolean => {
    // Doctor also converges the recognized predecessor after version publication.
    let changed = false;
    for (const table of publicationDraftTables) {
      // Null retains the accepted draft intent and digest; absent feature tables stay lazy.
      changed = ensureColumn(db, table, "draft INTEGER") || changed;
    }
    return changed;
  },
  applied: "Retained the requested GitHub PR draft choice (v28)",
};

/** Exact predecessor shape for publication migration admission and PostgreSQL backups. */
export function withLegacyPublicationDraft(schema: string): string {
  return schema.replace(
    /(CREATE TABLE(?: IF NOT EXISTS)? "?github_(?:personal_|repository_)?publication_requests"? \([\s\S]*?)\n {2}(?:"draft" bigint|draft INTEGER),/gu,
    "$1",
  );
}

/** Historical publication rows retain unknown requesters; first use still owns absent tables. */
export function migrateGitHubPublicationRequesterAuthority(
  db: DatabaseSync,
  previousVersion: number,
): boolean {
  if (previousVersion >= 18) {
    return false;
  }
  let changed = false;
  for (const table of [
    "github_publication_session_lifecycles",
    "github_repository_publication_requests",
  ]) {
    if (tableExists(db, table)) {
      changed = ensureColumn(db, table, "requester_authority_json TEXT") || changed;
    }
  }
  return changed;
}
