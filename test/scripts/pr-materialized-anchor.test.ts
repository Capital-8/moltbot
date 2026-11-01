import { spawnSync } from "node:child_process";
import {
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const describePosix = process.platform === "win32" ? describe.skip : describe;

function anchorFixture() {
  const root = realpathSync(tempDirs.make("pr-anchor-owner-"));
  const anchor = join(root, "openclaw-pr-anchor.owned");
  const unrelated = join(root, "openclaw-pr-anchor.unrelated");
  mkdirSync(anchor, { mode: 0o700 });
  mkdirSync(unrelated, { mode: 0o700 });
  mkdirSync(join(anchor, "scripts/pr-lib"), { recursive: true });
  writeFileSync(join(anchor, "scripts/pr"), "#!/bin/sh\n");
  cpSync(
    "scripts/pr-lib/materialized-anchor.mjs",
    join(anchor, "scripts/pr-lib/materialized-anchor.mjs"),
  );
  writeFileSync(join(unrelated, "sentinel"), "retained\n");
  symlinkSync(unrelated, join(anchor, "node_modules"), "dir");
  return { root, anchor, unrelated };
}

function retire(fixture: ReturnType<typeof anchorFixture>, fault = "none") {
  const descriptor = openSync(
    fault === "different held directory" ? fixture.unrelated : fixture.anchor,
    "r",
  );
  try {
    const alias = join(fixture.root, "openclaw-pr-anchor.alias");
    if (fault === "symlinked path") {
      symlinkSync(fixture.anchor, alias, "dir");
    }
    // Give only this child a real FD9; the test worker's descriptor table stays intact.
    return spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        String.raw`
import { chmodSync, closeSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const [anchor, scriptRoot, fault] = process.argv.slice(1);
const { claimMaterializedAnchor, retireMaterializedAnchor } =
  await import(pathToFileURL(join(anchor, "scripts/pr-lib/materialized-anchor.mjs")).href);
process.env.OPENCLAW_PR_ANCHOR_CREATOR_PID =
  String(fault === "wrong creator" ? process.pid + 1 : process.pid);
process.env.OPENCLAW_PR_ANCHOR_FD = fault === "wrong descriptor declaration" ? "8" : "9";
if (fault === "missing descriptor") closeSync(9);
const claimed = claimMaterializedAnchor(join(scriptRoot, "scripts/pr"));
if (fault === "closed descriptor after claim") closeSync(9);
if (fault === "changed mode") chmodSync(anchor, 0o755);
if (fault === "replaced path") {
  renameSync(anchor, anchor + ".retained");
  mkdirSync(anchor, { mode: 0o700 });
  writeFileSync(join(anchor, "replacement"), "retained replacement\n");
}
retireMaterializedAnchor(claimed);
console.log(JSON.stringify({ claimed: Boolean(claimed) }));
`,
        fixture.anchor,
        fault === "symlinked path" ? alias : fixture.anchor,
        fault,
      ],
      {
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        stdio: [
          "ignore",
          "pipe",
          "pipe",
          "ignore",
          "ignore",
          "ignore",
          "ignore",
          "ignore",
          "ignore",
          descriptor,
        ],
      },
    );
  } finally {
    closeSync(descriptor);
  }
}

describePosix("materialized PR anchor ownership", () => {
  it("retires only the claimed anchor without following external dependency symlinks", () => {
    const fixture = anchorFixture();
    const unrelated = lstatSync(fixture.unrelated);
    const result = retire(fixture);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ claimed: true });
    expect(existsSync(fixture.anchor)).toBe(false);
    expect(lstatSync(fixture.unrelated).ino).toBe(unrelated.ino);
    expect(readFileSync(join(fixture.unrelated, "sentinel"), "utf8")).toBe("retained\n");
  });

  it.each([
    { fault: "missing descriptor", claimed: false },
    { fault: "wrong creator", claimed: false },
    { fault: "wrong descriptor declaration", claimed: false },
    { fault: "different held directory", claimed: false },
    { fault: "symlinked path", claimed: false },
    { fault: "closed descriptor after claim", claimed: true },
    { fault: "changed mode", claimed: true },
    { fault: "replaced path", claimed: true },
  ])("retains anchor custody after $fault", ({ fault, claimed }) => {
    const fixture = anchorFixture();
    const before = lstatSync(fixture.anchor);
    const unrelated = lstatSync(fixture.unrelated);
    const result = retire(fixture, fault);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ claimed });
    expect(existsSync(fixture.anchor)).toBe(true);
    if (fault === "replaced path") {
      expect(lstatSync(fixture.anchor + ".retained").ino).toBe(before.ino);
      expect(readFileSync(join(fixture.anchor, "replacement"), "utf8")).toBe(
        "retained replacement\n",
      );
    } else {
      expect(lstatSync(fixture.anchor).ino).toBe(before.ino);
    }
    expect(lstatSync(fixture.unrelated).ino).toBe(unrelated.ino);
    expect(readFileSync(join(fixture.unrelated, "sentinel"), "utf8")).toBe("retained\n");
  });
});
