import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { listGitTrackedFiles } from "../../test-utils/repo-files.js";
import allowlist from "./catalog-model-id-rules.allowlist.json" with { type: "json" };

// Model facts belong in catalog rows (src/plugins/AGENTS.md "Model Listing"), so a new model in
// a known family ships as a manifest row, not as another entry in a code list. This guard freezes
// every production file that names a bundled catalog row ID today. A new name fails: put the fact
// in the row instead, or add the file entry with the inventory reason in the PR. Removing a name
// fails too, until the allowlist shrinks with it.
const repoRoot = path.resolve(import.meta.dirname, "../../..");
const SKIPPED =
  /\.(?:test|spec|e2e|live)\.|test-(?:support|helpers?|harness|utils)|harness\.|\.d\.ts$|\.generated\.|\/fixtures\/|\/probes\//;
const STRING_LITERAL = /["'`]([\w.:/[\]-]{4,})["'`]/g;

function listFiles(pathspecs: string): string[] {
  const files = listGitTrackedFiles({ repoRoot, pathspecs });
  if (!files) {
    throw new Error("unable to list repository files from git");
  }
  return files;
}

function readCatalogRowIds(): Set<string> {
  const ids = new Set<string>();
  for (const file of listFiles("extensions")) {
    if (!/^extensions\/[^/]+\/openclaw\.plugin\.json$/.test(file)) {
      continue;
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, file), "utf8")) as {
      modelCatalog?: { providers?: Record<string, { models?: Array<{ id: string }> }> };
    };
    for (const provider of Object.values(manifest.modelCatalog?.providers ?? {})) {
      for (const model of provider.models ?? []) {
        ids.add(model.id.toLowerCase());
      }
    }
  }
  return ids;
}

it("keeps catalog row IDs out of new production code", () => {
  const rowIds = readCatalogRowIds();
  const found: Record<string, string[]> = {};
  for (const pathspec of ["extensions", "src", "packages"]) {
    for (const file of listFiles(pathspec)) {
      if (!file.endsWith(".ts") || SKIPPED.test(file)) {
        continue;
      }
      const ids = new Set<string>();
      for (const [, literal] of fs
        .readFileSync(path.join(repoRoot, file), "utf8")
        .matchAll(STRING_LITERAL)) {
        if (literal && rowIds.has(literal.toLowerCase())) {
          ids.add(literal.toLowerCase());
        }
      }
      if (ids.size > 0) {
        found[file] = [...ids].toSorted();
      }
    }
  }
  expect(found).toEqual(allowlist.files);
});
