import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { Header, Pax } from "tar";
import { afterEach, expect, it } from "vitest";
import { extractPackageTarball } from "../../scripts/lib/openclaw-package-tarball.mts";

const owned: string[] = [];
afterEach(async () => {
  await Promise.all(owned.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function fixture(extraPath?: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "package-extraction-"));
  owned.push(dir);
  const blocks: Buffer[] = [];
  for (const [name, mode, body, size] of [
    ["package/package.json", 0o666, "{}", 2],
    [extraPath ?? "package/bin/run", 0o777, "run", 3],
  ] as const) {
    const header = new Header({ path: name, type: "File", mode, size });
    const block = Buffer.alloc(512);
    if (header.encode(block)) {
      blocks.push(new Pax({ path: name, size }).encode());
    }
    blocks.push(block, Buffer.from(body), Buffer.alloc(512 - body.length));
  }
  blocks.push(Buffer.alloc(1024));
  const bytes = gzipSync(Buffer.concat(blocks));
  const tarball = path.join(dir, "input.tgz");
  const workspace = path.join(dir, "private");
  await fs.writeFile(tarball, bytes);
  await fs.mkdir(workspace, { mode: 0o700 });
  return {
    tarball,
    workspace,
    expected: { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length },
    inspectLimits: true,
  };
}

it("materializes the receipt-bound package with safe modes and implicit directories", async () => {
  const options = await fixture();
  await extractPackageTarball(options);
  expect(await fs.readFile(path.join(options.workspace, "extract/package/bin/run"), "utf8")).toBe(
    "run",
  );
  if (process.platform !== "win32") {
    expect(
      (await fs.stat(path.join(options.workspace, "extract/package/package.json"))).mode & 0o777,
    ).toBe(0o644);
    expect(
      (await fs.stat(path.join(options.workspace, "extract/package/bin/run"))).mode & 0o777,
    ).toBe(0o755);
    expect((await fs.stat(path.join(options.workspace, "extract/package/bin"))).mode & 0o777).toBe(
      0o755,
    );
  }
});

it("refuses receipt mismatch before materializing any package file", async () => {
  const options = await fixture();
  options.expected.sha256 = "0".repeat(64);
  await expect(extractPackageTarball(options)).rejects.toThrow("snapshot digest/size mismatch");
  expect(await fs.readdir(options.workspace)).toEqual(["candidate.tgz"]);
});

it("retains the public path-component ceiling before extraction", async () => {
  const options = await fixture("package/" + "a/".repeat(256) + "file");
  await expect(extractPackageTarball(options)).rejects.toMatchObject({
    code: "archive-entry-path-components-exceeds-limit",
  });
  expect(await fs.readdir(options.workspace)).toEqual(["candidate.tgz"]);
});

it("never replaces an existing private snapshot", async () => {
  const options = await fixture();
  await fs.writeFile(path.join(options.workspace, "candidate.tgz"), "preserve");
  await expect(extractPackageTarball(options)).rejects.toThrow();
  expect(await fs.readFile(path.join(options.workspace, "candidate.tgz"), "utf8")).toBe("preserve");
});
