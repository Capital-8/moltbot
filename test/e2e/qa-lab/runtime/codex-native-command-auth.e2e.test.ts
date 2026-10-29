import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import https from "node:https";
import { createRequire } from "node:module";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import {
  PROXY_FIXTURE_CERTIFICATE,
  PROXY_FIXTURE_KEY,
} from "../../../../src/test-helpers/proxy-tls-fixture.js";
import { reserveTestPortListener } from "../../../../src/test-utils/port-claims.js";
import { connectGatewayStatusClient } from "../../../helpers/gateway-e2e-harness.js";
import { writeOpenAiResponsesText } from "../../../helpers/openai-responses-sse.js";
import { createOpenClawTestInstance } from "../../../helpers/openclaw-test-instance.js";
import { runQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";

// Public test-only leaf signed by PROXY_FIXTURE_CERTIFICATE.
const SERVER_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIBhTCCASugAwIBAgIBAjAKBggqhkjOPQQDAjAbMRkwFwYDVQQDDBBmaWxlcy5w
cm94eS50ZXN0MCAXDTI2MTAyODA1MzQ0N1oYDzIxMjYxMDA0MDUzNDQ3WjAUMRIw
EAYDVQQDDAkxMjcuMC4wLjEwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAS2agSj
NN3IROHs3GAdJdxO0snmqgW2RetuJKeRbn/e082TR8Sx5/yPcAcyAp6hEH19g3tF
/CT7/QGiGm96BZheo2UwYzAMBgNVHRMBAf8EAjAAMA4GA1UdDwEB/wQEAwIHgDAT
BgNVHSUEDDAKBggrBgEFBQcDATAPBgNVHREECDAGhwR/AAABMB0GA1UdDgQWBBRQ
mY8ZLuaAJjUU4JiehaVg+f+KoDAKBggqhkjOPQQDAgNIADBFAiEAv6I7QWvupklp
hanSnrw4JsVCI2kI/YCizAz6F1Lcr6kCIFCwSRa2gtugKpCQ9YeTPCVylRLd/K+p
IVAnJ8E0VJ6i
-----END CERTIFICATE-----`;
const PROVIDER = "command-fixture";
const MODEL = "gpt-5.6-luna";
const MODEL_REF = PROVIDER + "/" + MODEL;
const TOKEN = "synthetic-command-only-token";
const ANSWER = "P5_NATIVE_COMMAND_GATEWAY_OK";

it(
  "executes command auth through an ordinary Gateway session without host credentials",
  { timeout: 240_000 },
  async ({ signal }) => {
    const require = createRequire(path.join(process.cwd(), "extensions/codex/package.json"));
    const launcher = path.join(
      path.dirname(require.resolve("@openai/codex/package.json")),
      "bin/codex.js",
    );
    const requests: Array<{ model: unknown; commandBearer: boolean }> = [];
    const failures: string[] = [];
    const reserved = await reserveTestPortListener({
      offsets: [0],
      signal,
      createListener: () =>
        https.createServer(
          { key: PROXY_FIXTURE_KEY, cert: SERVER_CERTIFICATE },
          (request, response) => {
            void (async () => {
              if (request.method !== "POST" || request.url !== "/v1/responses") {
                request.resume();
                response.writeHead(404).end();
                return;
              }
              const chunks: Buffer[] = [];
              for await (const chunk of request) {
                chunks.push(Buffer.from(chunk));
              }
              const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              if (!isRecord(parsed)) {
                throw new Error("Invalid Responses request");
              }
              requests.push({
                model: parsed.model,
                commandBearer: request.headers.authorization === "Bearer " + TOKEN,
              });
              writeOpenAiResponsesText(response, {
                text: ANSWER,
                messageId: "message-" + requests.length,
                responseId: "response-" + requests.length,
              });
            })().catch((error: unknown) => {
              failures.push(String(error));
              response.writeHead(500).end();
            });
          },
        ),
    });
    const baseUrl = "https://127.0.0.1:" + reserved.claim.port + "/v1";
    const profile = "p5-native-command-proof";
    const instance = await createOpenClawTestInstance({
      name: profile,
      signal,
      entrypoint: ["dist/index.js", "--profile", profile],
      env: {
        OPENCLAW_PROFILE: profile,
        OPENCLAW_SKIP_PROVIDERS: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        OPENAI_API_KEY: undefined,
        CODEX_API_KEY: undefined,
        CODEX_ACCESS_TOKEN: undefined,
      },
      config: {
        models: {
          mode: "replace",
          catalogRefresh: { enabled: false },
          providers: {
            [PROVIDER]: {
              auth: "native-command",
              api: "openai-responses",
              baseUrl,
              agentRuntime: { id: "codex" },
              models: [
                {
                  id: MODEL,
                  name: "Synthetic command model",
                  reasoning: true,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 100000,
                  maxTokens: 1000,
                },
              ],
            },
          },
        },
        plugins: {
          enabled: true,
          allow: ["codex"],
          entries: {
            codex: {
              enabled: true,
              config: {
                appServer: {
                  command: launcher,
                  args: ["app-server"],
                  mode: "yolo",
                  sandbox: "read-only",
                  requestTimeoutMs: 60000,
                },
              },
            },
          },
        },
        agents: {
          defaults: {
            model: { primary: MODEL_REF, fallbacks: [] },
            workspace: "~/workspace",
            skipBootstrap: true,
            skills: [],
            timeoutSeconds: 60,
            sandbox: { mode: "off" },
          },
        },
      },
    });
    await runQaGatewayFixture(
      async () => {
        instance.env.OPENCLAW_GATEWAY_PORT = String(instance.port);
        const ca = instance.state.path("fixture-ca.pem");
        await fs.writeFile(ca, PROXY_FIXTURE_CERTIFICATE);
        instance.env.SSL_CERT_FILE = ca;
        const codexHome = path.join(instance.state.agentDir(), "codex-home");
        await fs.mkdir(codexHome, { recursive: true });
        const command = instance.state.path("token-command.mjs");
        await fs.writeFile(
          command,
          [
            "if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY || process.env.CODEX_ACCESS_TOKEN) process.exit(21);",
            "process.stdout.write(" + JSON.stringify(TOKEN) + ");",
          ].join("\n"),
        );
        await fs.writeFile(
          path.join(codexHome, "config.toml"),
          [
            "model=" + JSON.stringify(MODEL),
            "model_provider=" + JSON.stringify(PROVIDER),
            'cli_auth_credentials_store="ephemeral"',
            'web_search="disabled"',
            'approval_policy="never"',
            'sandbox_mode="read-only"',
            "allow_login_shell=false",
            "[features]",
            "shell_snapshot=false",
            "[analytics]",
            "enabled=false",
            "[feedback]",
            "enabled=false",
            "[model_providers." + PROVIDER + "]",
            'name="Synthetic command provider"',
            "base_url=" + JSON.stringify(baseUrl),
            'wire_api="responses"',
            "requires_openai_auth=false",
            "supports_websockets=false",
            "request_max_retries=0",
            "stream_max_retries=0",
            "[model_providers." + PROVIDER + ".auth]",
            "command=" + JSON.stringify(process.execPath),
            "args=[" + JSON.stringify(command) + "]",
          ].join("\n"),
        );
        await instance.state.writeAuthProfiles({
          version: 1,
          profiles: {
            "openai:decoy": { type: "api_key", provider: "openai", key: "synthetic-stored-decoy" },
          },
        });
        instance.env.OPENAI_API_KEY = "synthetic-env-decoy";
        instance.env.CODEX_API_KEY = "synthetic-codex-decoy";
        instance.env.CODEX_ACCESS_TOKEN = "synthetic-token-decoy";
        await instance.startGateway();
        const client = await connectGatewayStatusClient(instance);
        await runQaGatewayFixture(
          async () => {
            const sessionKey = "agent:main:p5-native-command-" + randomUUID();
            await client.request("sessions.create", {
              key: sessionKey,
              agentId: "main",
              model: MODEL_REF,
            });
            const result = await client.request<{
              status: string;
              runId: string;
            }>(
              "agent",
              {
                sessionKey,
                message: "Reply with the harmless fixture response.",
                deliver: false,
                idempotencyKey: randomUUID(),
              },
              { expectFinal: true, timeoutMs: 90000 },
            );
            expect(result, instance.logs()).toMatchObject({
              status: "ok",
              result: {
                meta: {
                  agentMeta: {
                    provider: PROVIDER,
                    model: MODEL,
                    agentHarnessId: "codex",
                    credentialSource: { kind: "none" },
                  },
                },
              },
            });
            await expect(
              client.request(
                "agent.wait",
                { runId: result.runId, timeoutMs: 60000 },
                { timeoutMs: 65000 },
              ),
            ).resolves.toMatchObject({
              status: "ok",
              terminalReply: { disposition: "visible", text: ANSWER },
            });
            expect(requests).toEqual([{ model: MODEL, commandBearer: true }]);
            expect(failures).toEqual([]);
            await expect(fs.stat(path.join(codexHome, "auth.json"))).rejects.toMatchObject({
              code: "ENOENT",
            });
          },
          () => client.stopAndWait(),
          () => instance.stopGateway(),
        );
      },
      () => instance.cleanup(),
      async () => {
        reserved.listener.closeAllConnections();
        await reserved.releaseListener();
        await reserved.claim.release();
      },
    );
  },
);
