import { EventEmitter, once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("./app-server/transport-process-registration.js", () => ({
  prepareCodexAppServerProcessRegistration: async () => async () => {},
  waitForCodexAppServerProcessRegistrationCleanup: async () => {},
}));
import { buildCodexAppServerInitializeParams } from "./app-server/client-initialize.js";
import {
  createCodexDynamicToolSpecs,
  projectCodexDynamicTools,
} from "./app-server/dynamic-tool-catalog.js";
import { setManagedCodexPluginRoot } from "./app-server/managed-binary.js";
import { buildCodexRuntimeThreadConfig } from "./app-server/thread-requests.js";
import { createCodexNodeAppServerCommand } from "./node-exec-server.js";

afterEach(() => {
  vi.unstubAllEnvs();
  setManagedCodexPluginRoot(undefined);
});

describe("Codex worker model process", () => {
  it("sends an authenticated worker turn and resumes its native thread from private lease state", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codex-worker-model-")));
    let server: http.Server | undefined;
    try {
      const requests: Array<{
        authorization: string | undefined;
        model: unknown;
        toolNames: string[];
      }> = [];
      server = http.createServer((request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => {
          body += chunk;
        });
        request.on("end", () => {
          if (request.method !== "POST" || request.url !== "/v1/responses") {
            response.writeHead(404).end();
            return;
          }
          const parsed = JSON.parse(body) as { model?: unknown; tools?: Array<{ name?: string }> };
          requests.push({
            authorization: request.headers.authorization,
            model: parsed.model,
            toolNames: (parsed.tools ?? []).flatMap((tool) =>
              typeof tool.name === "string" ? [tool.name] : [],
            ),
          });
          const events = [
            { type: "response.created", response: { id: "worker-response" } },
            {
              type: "response.output_item.done",
              item: {
                type: "message",
                role: "assistant",
                id: "worker-answer",
                content: [{ type: "output_text", text: "Worker inference completed." }],
              },
            },
            {
              type: "response.completed",
              response: {
                id: "worker-response",
                usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
              },
            },
          ];
          response.writeHead(200, { "Content-Type": "text/event-stream" });
          response.end(
            events
              .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
              .join(""),
          );
        });
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Missing fake Responses address");
      }
      const state = path.join(root, "state");
      const configDir = path.join(state, "codex-runtime");
      const workspaceDir = path.join(root, "repo");
      await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
      await fs.mkdir(workspaceDir);
      await fs.writeFile(path.join(configDir, "version"), "a".repeat(64), { mode: 0o600 });
      await fs.writeFile(
        path.join(configDir, "config.toml"),
        `model = "codex-test-model"\nmodel_provider = "autodev"\n[model_providers.autodev]\nname = "AutoDev"\nbase_url = "http://127.0.0.1:${address.port}/v1"\nwire_api = "responses"\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n[model_providers.autodev.auth]\ncommand = "node"\nargs = ["${path.join(configDir, "autodev-token.mjs")}"]\n`,
        { mode: 0o600 },
      );
      await fs.writeFile(
        path.join(configDir, "autodev-token.mjs"),
        "process.stdout.write('synthetic-worker-bearer\\n')\n",
        { mode: 0o600 },
      );
      vi.stubEnv("OPENCLAW_STATE_DIR", state);
      setManagedCodexPluginRoot(fileURLToPath(new URL("../", import.meta.url)));
      const command = createCodexNodeAppServerCommand();
      expect(command.isAvailable?.({ config: {}, env: process.env })).toBe(true);
      await command.prepare?.({ config: {}, env: process.env });
      const placement = {
        cwd: workspaceDir,
        environmentId: "worker-environment",
        sessionId: "worker-session",
        ownerEpoch: 1,
        sessionKey: "agent:main:worker-session",
        retainedSession: true,
      };
      const runConnection = async <T>(
        use: (
          request: (id: number, method: string, params: unknown) => Promise<unknown>,
          notify: (method: string) => Promise<void>,
          waitNotification: (method: string) => Promise<unknown>,
        ) => Promise<T>,
      ): Promise<T> => {
        const controller = new AbortController();
        const replies = new EventEmitter();
        let receiver: ((message: Uint8Array) => void | Promise<void>) | undefined;
        let ready!: () => void;
        const listening = new Promise<void>((resolve) => {
          ready = resolve;
        });
        const release = vi.fn();
        const running = command.handle(
          JSON.stringify({
            placement,
            authorization: "session-full",
            resourcePreparationRequired: true,
            github: {
              host: "microsoft.ghe.com",
              login: "test-app[bot]",
              token: "synthetic-initial",
            },
          }),
          {
            emitChunk: async () => {},
            onInput: () => {},
            signal: controller.signal,
            frames: {
              send: async (frame) => {
                const response = JSON.parse(Buffer.from(frame).toString("utf8")) as { id?: number };
                replies.emit(String(response.id), response);
                if ("method" in response && typeof response.method === "string") {
                  replies.emit(response.method, response);
                }
              },
              onMessage: (listener) => {
                receiver = listener;
                ready();
                return () => {
                  receiver = undefined;
                };
              },
            },
          },
          {
            sessionKey: placement.sessionKey,
            sendNodeEvent: async () => undefined,
            prepareExecAuthorization: () => () => {},
            acquireManagedWorkspaceAsync: async () => ({
              workspaceDir,
              release,
            }),
          },
        );
        await listening;
        const notify = async (method: string) => {
          await receiver?.(Buffer.from(JSON.stringify({ method, params: {} })));
        };
        const request = async (id: number, method: string, params: unknown) => {
          const response = once(replies, String(id));
          await receiver?.(Buffer.from(JSON.stringify({ id, method, params })));
          return (await response)[0] as unknown;
        };
        const waitNotification = async (method: string) =>
          (await once(replies, method))[0] as unknown;
        try {
          return await use(request, notify, waitNotification);
        } finally {
          controller.abort(new Error("test complete"));
          await expect(running).rejects.toThrow();
          expect(release).toHaveBeenCalledOnce();
        }
      };
      const threadId = await runConnection(async (request, notify, waitNotification) => {
        await expect(
          request(1, "initialize", buildCodexAppServerInitializeParams()),
        ).resolves.toMatchObject({
          result: { userAgent: expect.any(String) },
        });
        await notify("initialized");
        const pendingRead = request(20, "fs/readFile", {
          path: path.join(workspaceDir, "readiness-proof.txt"),
        });
        let readSettled = false;
        void pendingRead.then(() => {
          readSettled = true;
        });
        const started = (await request(2, "thread/start", {
          cwd: workspaceDir,
          modelProvider: "autodev",
          model: "codex-test-model",
          config: buildCodexRuntimeThreadConfig(undefined),
          dynamicTools: createCodexDynamicToolSpecs({
            entries: projectCodexDynamicTools(
              ["get_goal", "create_goal", "update_goal"].map((name) => ({
                name,
                description: "Core Goal control",
                parameters: { type: "object", properties: {}, additionalProperties: false },
              })),
            ).tools,
            loading: "searchable",
          }),
        })) as { result: { thread: { id: string } } };
        const startedThreadId = started.result.thread.id;
        const completed = waitNotification("turn/completed");
        await expect(
          request(3, "turn/start", {
            threadId: startedThreadId,
            input: [{ type: "text", text: "Reply briefly.", text_elements: [] }],
          }),
        ).resolves.toHaveProperty("result");
        await expect(completed).resolves.toMatchObject({
          params: { threadId: startedThreadId, turn: { status: "completed" } },
        });
        expect(readSettled).toBe(false);
        await fs.writeFile(path.join(workspaceDir, "readiness-proof.txt"), "verified readiness");
        await expect(
          request(21, "openclaw/resources/settle", { status: "unknown" }),
        ).resolves.toMatchObject({ error: { code: -32001 } });
        expect(readSettled).toBe(false);
        await expect(
          request(22, "openclaw/resources/settle", { status: "ready" }),
        ).resolves.toMatchObject({ result: {} });
        await expect(
          request(23, "openclaw/resources/settle", { status: "ready" }),
        ).resolves.toMatchObject({ error: { code: -32001 } });
        await expect(pendingRead).resolves.toMatchObject({
          result: { dataBase64: Buffer.from("verified readiness").toString("base64") },
        });
        const readCredential = async (id: number) =>
          request(id, "command/exec", {
            command: [
              process.execPath,
              "-e",
              "process.stdout.write(JSON.stringify({token:process.env.GH_TOKEN,other:process.env.GH_ENTERPRISE_TOKEN,host:process.env.GH_HOST}))",
            ],
            cwd: workspaceDir,
          });
        await expect(readCredential(30)).resolves.toMatchObject({
          result: {
            stdout: JSON.stringify({
              token: "synthetic-initial",
              other: "",
              host: "microsoft.ghe.com",
            }),
          },
        });
        await expect(
          request(31, "openclaw/github/refresh", {
            generation: 1,
            token: "synthetic-renewed",
            expiresAtMs: Date.now() + 3_600_000,
          }),
        ).resolves.toMatchObject({ result: { generation: 1 } });
        await expect(readCredential(32)).resolves.toMatchObject({
          result: {
            stdout: JSON.stringify({
              token: "synthetic-renewed",
              other: "",
              host: "microsoft.ghe.com",
            }),
          },
        });

        return startedThreadId;
      });
      expect(requests).toEqual([
        {
          authorization: "Bearer synthetic-worker-bearer",
          model: "codex-test-model",
          toolNames: expect.arrayContaining(["get_goal", "create_goal", "update_goal"]),
        },
      ]);
      expect(threadId).toMatch(/^[a-f0-9-]+$/);
      await runConnection(async (request, notify) => {
        await request(1, "initialize", buildCodexAppServerInitializeParams());
        await notify("initialized");
        await expect(request(2, "thread/resume", { threadId })).resolves.toMatchObject({
          result: { thread: { id: threadId } },
        });
        await expect(request(3, "thread/start", { cwd: workspaceDir })).resolves.toMatchObject({
          error: { code: -32001, message: expect.stringContaining("existing thread") },
        });
        const read = request(20, "fs/readFile", {
          path: path.join(workspaceDir, "readiness-proof.txt"),
        });
        await expect(
          request(21, "openclaw/resources/settle", { status: "failed" }),
        ).resolves.toMatchObject({ result: {} });
        await expect(read).resolves.toMatchObject({ error: { code: -32001 } });
        await expect(
          request(22, "openclaw/resources/settle", { status: "ready" }),
        ).resolves.toMatchObject({ error: { code: -32001 } });
      });
      await fs.rm(path.join(state, "codex-runtime", "sessions"), { recursive: true, force: true });
      const missingHomeRelease = vi.fn();
      const acceptFrames = vi.fn();
      await expect(
        command.handle(
          JSON.stringify({
            placement: { ...placement, requireExistingNativeState: true },
            authorization: "session-full",
          }),
          {
            emitChunk: async () => {},
            onInput: () => {},
            signal: new AbortController().signal,
            frames: { send: async () => {}, onMessage: acceptFrames },
          },
          {
            sessionKey: placement.sessionKey,
            sendNodeEvent: async () => undefined,
            prepareExecAuthorization: () => () => {},
            acquireManagedWorkspaceAsync: async () => ({
              workspaceDir,
              release: missingHomeRelease,
            }),
          },
        ),
      ).rejects.toThrow("session home is missing");
      expect(acceptFrames).not.toHaveBeenCalled();
      expect(missingHomeRelease).toHaveBeenCalledOnce();
      expect(requests).toHaveLength(1);
    } finally {
      server?.closeAllConnections();
      if (server?.listening) {
        await new Promise<void>((resolve) => {
          server!.close(() => resolve());
        });
      }
      await fs.rm(root, { force: true, recursive: true });
    }
  }, 45_000);
});
