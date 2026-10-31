import { randomUUID, X509Certificate } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { UsersSelfResult } from "../../packages/gateway-protocol/src/schema/users.js";
import {
  closeHttpServer,
  listenLoopback,
  readRequestText,
  respondJson,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
} from "../infra/device-identity.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import { requestDevicePairing } from "../infra/device-pairing.js";
import { defaultRuntime } from "../runtime.js";
import { getSessionControllerOperation } from "../sessions/session-controller.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { writeToolCall } from "./gateway-provider-fixture.test-support.js";
import {
  createGatewayConfigPath,
  removeGatewayTempHome,
  resetGatewayTestState,
  setupGatewayTempHome,
} from "./gateway.test-support.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  startGatewayWithClient,
} from "./test-helpers.e2e.js";
import { kernelGatewayTestStateOptions } from "./test-helpers.env.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

// Real WS authentication, agent orchestration and HTTP effects; only model output and room data are fixtures.
it(
  "carries a personal UI requester through a model read/draft and rejects revoked effects",
  { timeout: 180_000 },
  ({ signal }) =>
    withOpenClawTestState(kernelGatewayTestStateOptions("plugin-requester-effects"), async () => {
      resetGatewayTestState();
      const logErrors = vi.spyOn(defaultRuntime, "error");
      const home = await setupGatewayTempHome({ prefix: "openclaw-plugin-requester-effects-" });
      const effects: Array<{
        operation: string;
        profileId: string;
        owner: boolean;
        sender?: string;
      }> = [];
      const refusals: string[] = [];
      const inventories: string[][] = [];
      const errors: unknown[] = [];
      let pauseDraft = false;
      let entered = createDeferred();
      let release = createDeferred();
      let refused = createDeferred();
      const room = createServer((request, response) => {
        void (async () => {
          const url = new URL(request.url ?? "/", "http://127.0.0.1");
          if (url.pathname === "/prepare") {
            entered.resolve();
            if (pauseDraft) {
              await release.promise;
            }
            respondJson(response, { ready: true });
            return;
          }
          const body = JSON.parse(await readRequestText(request));
          if (url.pathname === "/refused") {
            refusals.push(body.profileId);
            refused.resolve();
            respondJson(response, {});
            return;
          }
          effects.push(body);
          if (url.pathname === "/draft") {
            // Named unsent mail artifact, not a new state store; no send route exists.
            await fs.writeFile(
              path.join(home.workspaceDir, "room-draft.eml"),
              "X-Unsent: 1\r\nX-Requester: " +
                body.profileId +
                "\r\nSubject: Room proof\r\n\r\nSynthetic draft only.\r\n",
            );
          }
          respondJson(response, { room: "synthetic-room", operation: body.operation });
        })().catch((error: unknown) => {
          errors.push(error);
          response.writeHead(500).end();
        });
      });
      const roomUrl = await listenLoopback(room);
      const provider = createServer((request, response) => {
        void (async () => {
          const body = JSON.parse(await readRequestText(request));
          const names = (body.tools ?? [])
            .map((tool: { name?: string }) => tool.name)
            .filter(Boolean);
          inventories.push(names);
          const outputs = (body.input ?? []).filter(
            (item: { type?: string }) => item.type === "function_call_output",
          );
          if (!names.includes("room_read") || !names.includes("room_draft")) {
            writeOpenAiResponsesText(response, {
              text: "Personal room tools unavailable.",
              messageId: randomUUID(),
              responseId: randomUUID(),
            });
          } else if (outputs.length === 0) {
            writeToolCall(response, "room_read", {});
          } else if (outputs.length === 1) {
            writeToolCall(response, "room_draft", {});
          } else {
            writeOpenAiResponsesText(response, {
              text: "Room read; draft remains unsent.",
              messageId: randomUUID(),
              responseId: randomUUID(),
            });
          }
        })().catch((error: unknown) => {
          errors.push(error);
          response.writeHead(500).end();
        });
      });
      const model = buildMockOpenAiResponsesProvider(
        (await listenLoopback(provider)) + "/v1",
        "requester-proof",
      );
      const pluginDir = path.join(home.tempHome, "room-proof-plugin");
      await fs.mkdir(pluginDir);
      await fs.writeFile(
        path.join(pluginDir, "openclaw.plugin.json"),
        JSON.stringify({
          id: "room-proof",
          activation: { onStartup: true },
          contracts: { tools: ["room_read", "room_draft"] },
          configSchema: {
            type: "object",
            properties: { baseUrl: { type: "string" } },
            required: ["baseUrl"],
            additionalProperties: false,
          },
        }),
      );
      await fs.writeFile(
        path.join(pluginDir, "index.js"),
        String.raw`
export default { id: "room-proof", register(api) {
 const baseUrl = api.pluginConfig.baseUrl;
 api.registerTool({ contextVersion: 2, create(ctx) {
  const profile = ctx.requesterProfile;
  if (ctx.senderIsOwner !== true || !profile) return null;
  return ["room_read", "room_draft"].map(name => ({ name, label: name, description: "Read a synthetic room or create an unsent draft; never send.", parameters: { type: "object", properties: {} },
   async execute() {
    if (name === "room_draft") await fetch(baseUrl + "/prepare");
    try { ctx.assertInvocationCurrent(); profile.assertCurrent(); }
    catch (error) { await fetch(baseUrl + "/refused", { method: "POST", body: JSON.stringify({ profileId: profile.id }) }); throw error; }
    const response = await fetch(baseUrl + (name === "room_draft" ? "/draft" : "/read"), { method: "POST", body: JSON.stringify({ operation: name, profileId: profile.id, owner: ctx.senderIsOwner, sender: ctx.requesterSenderId }) });
    return { content: [{ type: "text", text: await response.text() }], details: {} };
   }
  }));
 } }, { names: ["room_read", "room_draft"], workspaceAccess: false });
} };
`,
      );
      const certPath = path.join(home.tempHome, "cert.pem");
      const keyPath = path.join(home.tempHome, "key.pem");
      await fs.writeFile(certPath, TEST_TLS_CERT_PEM);
      await fs.writeFile(keyPath, TEST_TLS_KEY_PEM);
      const tlsFingerprint = new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256;
      const auth = {
        mode: "trusted-proxy" as const,
        trustedProxy: {
          userHeader: "x-forwarded-user",
          requiredHeaders: ["x-forwarded-proto"],
          allowLoopback: true,
        },
      };
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: home.workspaceDir,
            skipBootstrap: true,
            model: { primary: model.modelRef },
            models: {
              [model.modelRef]: {
                agentRuntime: { id: "openclaw" },
                params: { transport: "sse", openaiWsWarmup: false },
              },
            },
          },
        },
        models: {
          mode: "replace",
          providers: {
            [model.providerId]: { ...model.config, request: { allowPrivateNetwork: true } },
          },
        },
        plugins: {
          allow: ["room-proof"],
          load: { paths: [pluginDir] },
          slots: { memory: "none" },
          entries: { "room-proof": { enabled: true, config: { baseUrl: roomUrl } } },
        },
        tools: { allow: ["room_read", "room_draft"], codeMode: false, toolSearch: false },
        gateway: {
          auth,
          tls: { enabled: true, autoGenerate: false, certPath, keyPath },
          trustedProxies: ["127.0.0.1"],
          controlUi: { allowedOrigins: ["https://localhost"] },
          roles: {
            default: "admin",
            definitions: {
              admin: { scopes: ["operator.admin"], agents: "*", sessions: { others: "write" } },
              member: {
                scopes: ["operator.read", "operator.write"],
                agents: "*",
                sessions: { others: "none" },
              },
            },
          },
        },
        hooks: { enabled: false },
      };
      const headers = (person: string) => ({
        "x-forwarded-user": person + "@example.test",
        "x-forwarded-proto": "https",
        "x-forwarded-for": "203.0.113.10",
      });
      const devicePath = path.join(
        process.env.OPENCLAW_STATE_DIR!,
        "test-device-identities",
        "openclaw-control-ui-webchat-" + process.platform + "-none-operator",
        "client",
        "credentials.sqlite",
      );
      const identity = loadOrCreateDeviceIdentity({ path: devicePath });
      const pairing = await requestDevicePairing({
        deviceId: identity.deviceId,
        publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
        role: "operator",
        scopes: ["operator.admin", "operator.read", "operator.write"],
        clientId: "openclaw-control-ui",
        clientMode: "webchat",
        platform: process.platform,
        displayName: "Room proof",
      });
      await approveDevicePairing(pairing.request.requestId, { callerScopes: ["operator.admin"] });
      const clients: Awaited<ReturnType<typeof connectGatewayClient>>[] = [];
      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      await runQaGatewayFixture(
        async () => {
          gateway = await startGatewayWithClient({
            cfg,
            auth,
            secure: true,
            tlsFingerprint,
            configPath: await createGatewayConfigPath(home.tempHome),
            portClaim: await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] }),
            clientName: "openclaw-control-ui",
            mode: "webchat",
            origin: "https://localhost",
            edgeAuthHeaders: headers("administrator"),
            scopes: ["operator.admin", "operator.read", "operator.write"],
          });
          await gateway.server.startupSettled;
          const admin = gateway.client;
          const connectPerson = async (
            person: string,
            scopes = ["operator.admin", "operator.read", "operator.write"],
          ) => {
            const client = await connectGatewayClient({
              url: "wss://127.0.0.1:" + gateway!.port,
              tlsFingerprint,
              clientName: "openclaw-control-ui",
              mode: "webchat",
              origin: "https://localhost",
              edgeAuthHeaders: headers(person),
              instanceId: person,
              deviceIdentity: identity,
              scopes,
            });
            clients.push(client);
            const self = await client.request<UsersSelfResult>("users.self", {});
            expect(self.profile.id).not.toBe("gateway-owner");
            return { client, profileId: self.profile.id };
          };
          const send = async (client: typeof admin, key?: string) => {
            const runId = randomUUID();
            await client.request("chat.send", {
              sessionKey: key ?? "agent:main:room-proof-" + runId,
              message: "Read the room, then create an unsent draft. Never send it.",
              idempotencyKey: runId,
            });
            return runId;
          };
          const wait = (runId: string) =>
            admin.request<{ status: string }>(
              "agent.wait",
              { runId, timeoutMs: 30_000 },
              { timeoutMs: 35_000 },
            );
          const ada = await connectPerson("ada");
          expect(await wait(await send(ada.client))).toMatchObject({ status: "ok" });
          expect(inventories).toHaveLength(3);
          expect(effects).toEqual([
            { operation: "room_read", profileId: ada.profileId, owner: true },
            { operation: "room_draft", profileId: ada.profileId, owner: true },
          ]);
          expect(
            await fs.readFile(path.join(home.workspaceDir, "room-draft.eml"), "utf8"),
          ).toContain("X-Unsent: 1\r\nX-Requester: " + ada.profileId);
          const member = await connectPerson("member");
          await admin.request("users.setRole", { profileId: member.profileId, role: "member" });
          await disconnectGatewayClient(member.client);
          const memberSession = await connectPerson("member", ["operator.read", "operator.write"]);
          const before = effects.length;
          const requestCount = inventories.length;
          const memberResult = await wait(await send(memberSession.client));
          expect(memberResult).toMatchObject({ status: "error" });
          expect(logErrors.mock.calls.flat().join("\n")).toContain(
            "No callable tools remain after resolving explicit tool allowlist",
          );
          expect(inventories).toHaveLength(requestCount);
          expect(effects).toHaveLength(before);
          const artifact = await fs.readFile(
            path.join(home.workspaceDir, "room-draft.eml"),
            "utf8",
          );
          for (const reason of ["role", "disconnect", "profile-merge", "steer"] as const) {
            const person = await connectPerson(reason);
            pauseDraft = true;
            entered = createDeferred();
            release = createDeferred();
            refused = createDeferred();
            const sharedKey =
              reason === "steer"
                ? (
                    await person.client.request<{ key: string }>("sessions.create", {
                      agentId: "main",
                      visibility: "shared",
                    })
                  ).key
                : undefined;
            const runId = await send(person.client, sharedKey);
            const completed = wait(runId);
            await withinTest(
              awaitGateBeforeSettlement(
                entered.promise,
                completed,
                "Turn settled before plugin draft preparation",
              ),
              signal,
            );
            const afterRead = effects.length;
            expect(effects.at(-1)).toEqual({
              operation: "room_read",
              profileId: person.profileId,
              owner: true,
            });
            if (reason === "role") {
              await admin.request("users.setRole", { profileId: person.profileId, role: "member" });
            } else if (reason === "profile-merge") {
              const target = await connectPerson("merge-survivor");
              const merged = await admin.request<{ profile: { id: string } }>("users.merge", {
                sourceProfileId: person.profileId,
                targetProfileId: target.profileId,
              });
              expect(merged.profile.id).toBe(target.profileId);
            } else if (reason === "steer") {
              const other = await connectPerson("steerer");
              await other.client.request("chat.send", {
                sessionKey: sharedKey!,
                message: "Additional human guidance; do not send the draft.",
                queueMode: "steer",
                idempotencyKey: randomUUID(),
              });
              // Read the actual production owner; input is admitted only through chat.send.
              await vi.waitFor(() => {
                const participants = getSessionControllerOperation(
                  sharedKey!,
                )?.personalToolParticipants;
                expect(participants).toBeDefined();
                expect(participants?.resolve(person.profileId)?.profileId).toBe(person.profileId);
                expect(participants?.resolve(other.profileId)?.profileId).toBe(other.profileId);
                expect(() => participants?.resolve()).toThrow(
                  "Several people have steered this turn",
                );
              });
            } else {
              const connected = await admin.request<
                Array<{ instanceId?: string; reason?: string }>
              >("system-presence", {});
              expect(
                connected.some(
                  (entry) => entry.instanceId === reason && entry.reason !== "disconnect",
                ),
              ).toBe(true);
              await disconnectGatewayClient(person.client);
              await vi.waitFor(async () => {
                const presence = await admin.request<
                  Array<{ instanceId?: string; reason?: string }>
                >("system-presence", {});
                expect(
                  presence.some(
                    (entry) => entry.instanceId === reason && entry.reason !== "disconnect",
                  ),
                ).toBe(false);
              });
            }
            release.resolve();
            await withinTest(refused.promise, signal);
            expect(refusals).toContain(person.profileId);
            await completed;
            expect(effects).toHaveLength(afterRead);
            expect(await fs.readFile(path.join(home.workspaceDir, "room-draft.eml"), "utf8")).toBe(
              artifact,
            );
            pauseDraft = false;
          }
          expect(effects.filter((effect) => effect.operation === "room_draft")).toHaveLength(1);
          expect(errors).toEqual([]);
          console.log(
            "REQUESTER_EFFECT_PROOF: authenticated read + persisted X-Unsent draft; non-admin no I/O; role revocation + disconnect + profile merge + accepted second-person steer after preparation no draft I/O; zero sends",
          );
        },
        async () => {
          release.resolve();
          await Promise.all(clients.map(disconnectGatewayClient));
          if (gateway) {
            await disconnectGatewayClient(gateway.client);
            await gateway.server.close({ reason: "requester effect proof complete" });
          }
        },
        () => closeHttpServer(provider),
        () => closeHttpServer(room),
        async () => {
          resetGatewayTestState();
          await removeGatewayTempHome(home.tempHome);
          home.envSnapshot.restore();
          logErrors.mockRestore();
        },
      );
    }),
);
