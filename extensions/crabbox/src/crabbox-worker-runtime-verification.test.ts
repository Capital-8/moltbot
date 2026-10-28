import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Readable } from "node:stream";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { createCrabboxNodeRuntimeSetup } from "./crabbox-worker-node-enrollment.js";
import {
  createRuntimeVerificationFixture,
  createWorkerArchiveFixture,
} from "./crabbox-worker-node-enrollment.test-support.js";

const require = createRequire(import.meta.url);

describe("cached runtime manifest identity", () => {
  it.each([
    "unchanged",
    "modified-payload",
    "missing-manifest",
    "wrong-manifest",
    "missing-pin",
  ] as const)(
    "checks the expected manifest without inspecting payload files (%s)",
    async (change) => {
      const verification = createRuntimeVerificationFixture("linux", {
        files: new Map([["payload.js", Buffer.from("original payload")]]),
      });
      if (change === "modified-payload") {
        verification.files.set("payload.js", Buffer.from("modified payload"));
      } else if (change === "missing-manifest") {
        verification.files.delete("node-runtime.manifest.json");
      } else if (change === "wrong-manifest") {
        verification.files.set("node-runtime.manifest.json", Buffer.from("[]"));
      }
      const nodeBootstrap = {
        ...verification.nodeBootstrap,
        ...(change === "missing-pin" ? { manifestSha256: undefined } : {}),
      };
      const workerBytes = Buffer.from("synthetic worker archive");
      const workerSha = createHash("sha256").update(workerBytes).digest("hex");
      const workerBundle = {
        ...createWorkerArchiveFixture(),
        sha256: workerSha,
        bytes: workerBytes.length,
        packageRelativePath: `worker-artifacts/${workerSha}.tgz`,
      };
      const setup = createCrabboxNodeRuntimeSetup({
        leaseId: "cbx_manifest_fixture",
        nodeBootstrap,
        workerBundle,
      });
      const runtime = path.join(
        "/fixture",
        ".openclaw-worker",
        "node-runtimes",
        nodeBootstrap.sha256,
      );
      const packageRoot = path.join(runtime, "node_modules", "openclaw");
      const archive = path.join(packageRoot, workerBundle.packageRelativePath);
      const payloadRead = vi.fn(() => {
        throw new Error("Startup must not read payload bytes");
      });
      const payloadStat = vi.fn(() => {
        throw new Error("Startup must not stat payload files");
      });
      const enumerate = vi.fn((directory: string) => {
        expect(directory).toBe(path.dirname(archive));
        return [{ name: path.basename(archive) }];
      });
      const probe = vi.fn(() => ({ status: 0, stdout: "OpenClaw 2026.8.1" }));
      const output: string[] = [];
      const processFixture = {
        platform: "linux",
        arch: "x64",
        execPath: "/node",
        umask: () => {},
        env: { ...setup.forwardedEnv },
        exitCode: 0,
      };
      const fs = {
        constants,
        promises: {
          open: async (file: string) => {
            expect(file).toBe(archive);
            return {
              stat: async () => ({ isFile: () => true, nlink: 1, size: workerBytes.length }),
              createReadStream: () => Readable.from([workerBytes]),
              close: async () => {},
            };
          },
        },
        existsSync: (file: string) => file === runtime,
        mkdirSync: () => {},
        chmodSync: () => {},
        lstatSync: (file: string) => {
          if (file === runtime || file === path.dirname(archive)) {
            return { isDirectory: () => true };
          }
          return payloadStat();
        },
        realpathSync: (file: string) => file,
        readFileSync: (file: string) => {
          const name = path.relative(packageRoot, file);
          if (!["package.json", "node-runtime.json", "node-runtime.manifest.json"].includes(name)) {
            return payloadRead();
          }
          const bytes = verification.files.get(name);
          if (!bytes) {
            throw Object.assign(new Error("Missing manifest"), { code: "ENOENT" });
          }
          return bytes;
        },
        createReadStream: payloadRead,
        readdirSync: enumerate,
      };
      const script = setup.command
        .split("CRABBOX_NODE_ENROLLMENT_SCRIPT'\n")[1]!
        .split("\nCRABBOX_NODE_ENROLLMENT_SCRIPT")[0]!;
      await runInNewContext(script, {
        Buffer,
        AbortController,
        process: processFixture,
        console: {
          log: (line: string) => output.push(line),
          error: (line: string) => output.push(line),
        },
        require: (name: string) =>
          name === "node:os"
            ? { homedir: () => "/fixture" }
            : name === "node:fs"
              ? fs
              : name === "node:child_process"
                ? { spawnSync: probe }
                : require(name),
      });
      const accepted = change === "unchanged" || change === "modified-payload";
      expect(processFixture.exitCode, output.join("\n")).toBe(accepted ? 0 : 1);
      expect(payloadRead).not.toHaveBeenCalled();
      expect(payloadStat).not.toHaveBeenCalled();
      expect(probe).toHaveBeenCalledTimes(accepted ? 1 : 0);
      if (accepted) {
        expect(output).toContain("CRABBOX_PHASE:openclaw-bootstrap-complete");
        expect(enumerate).toHaveBeenCalledOnce();
      } else {
        expect(output.join("\n")).toContain(
          change === "missing-manifest" ? "Missing manifest" : "inventory does not match",
        );
      }
    },
  );
});
