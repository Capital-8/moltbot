// Real Gateway, real host authority and Knowledge workers; deterministic model I/O, not live inference.
import { randomUUID } from "node:crypto";
import { expect, it, onTestFinished } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../packages/gateway-protocol/src/schema/users.js";
import { writeToolCall } from "../src/gateway/gateway-provider-fixture.test-support.js";
import { connectGatewayClient, disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { assertGatewayAgentsAdmitted } from "./helpers/gateway-agent-admission.js";
import { readRequestText } from "./helpers/gateway-integration-fixtures.js";
import {
  createOpenAiResponsesModelConfig,
  startOpenAiResponsesModelServer,
} from "./helpers/openai-responses-model-fixture.js";
import { writeOpenAiResponsesText } from "./helpers/openai-responses-sse.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";

it(
  "shares a verified person's project, denies other tool routes, and preserves revocation after a new Gateway process",
  { timeout: 300_000 },
  async () => {
    let command:
      | { name: string; args: Record<string, unknown>; issued: boolean; output?: string }
      | undefined;
    let requests = 0;
    let activeAgent = "";
    const model = await startOpenAiResponsesModelServer({
      modelId: "person-proof",
      bindError: "Person proof fixture did not bind",
      onRequest: async (request, response) => {
        const raw = await readRequestText(request);
        if (activeAgent === "research") {
          expect(raw).not.toContain("Private cedar body.");
          expect(raw).not.toContain("Private cedar sentinel");
          expect(raw).not.toContain("Private cedar original");
        }
        const body = JSON.parse(raw);
        requests++;
        if (!command) {
          throw new Error("No proof command is active");
        }
        if (!command.issued) {
          command.issued = true;
          writeToolCall(response, command.name, command.args);
          return;
        }
        const outputs = body.input.filter(
          (item: { type?: string }) => item.type === "function_call_output",
        );
        command.output = outputs.at(-1)?.output;
        writeOpenAiResponsesText(response, {
          text: "Proof turn finished.",
          messageId: "message-" + requests,
          responseId: "response-" + requests,
        });
      },
    });
    onTestFinished(() => model.close());
    const config = createOpenAiResponsesModelConfig({
      baseUrl: model.baseUrl,
      providerId: "person-proof",
      modelId: "person-proof",
      reasoning: false,
      toolProfile: "minimal",
    });
    config.gateway = {
      http: { endpoints: { chatCompletions: { enabled: true }, responses: { enabled: true } } },
    };
    config.agents!.ownership = "explicit";
    config.agents!.entries = { main: {}, research: {} };
    delete config.agents!.defaults!.models;
    config.agents!.defaults!.modelPolicy = { allow: ["person-proof/person-proof"] };
    config.tools = {
      allow: [
        "knowledge_save_page",
        "knowledge_records",
        "knowledge_record",
        "knowledge_grep",
        "knowledge_lookup",
        "knowledge_attach",
        "knowledge_attachment",
        "knowledge_evidence_read",
      ],
      codeMode: false,
      toolSearch: false,
    };
    config.plugins = {
      slots: { memory: "knowledge" },
      entries: {
        knowledge: {
          enabled: true,
          config: {
            stores: { work: { agents: ["main", "research"] } },
            maintenance: { enabled: false },
          },
        },
      },
    };
    const instance = await createOpenClawTestInstance({
      name: "knowledge-person-project",
      config,
      env: {
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
        OPENCLAW_SKIP_PROVIDERS: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      },
    });
    let client: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
    const connect = () =>
      connectGatewayClient({
        url: instance.url,
        token: instance.gatewayToken,
        scopes: ["operator.admin", "operator.read", "operator.write"],
        requestTimeoutMs: 120_000,
      });
    const feature = async <T>(actionId: string, payload: unknown): Promise<T> => {
      const result = await client!.request<{ ok: boolean; result: T }>("plugins.sessionAction", {
        pluginId: "knowledge",
        actionId,
        payload,
      });
      expect(result.ok).toBe(true);
      return result.result;
    };
    const grant = async (agent: string, space: string, access = "read-write") => {
      const snapshot = await feature<{ revision: string }>("person_grants", {});
      const result = await feature<{ outcome: string }>("person_grant", {
        expectedRevision: snapshot.revision,
        profileId: GATEWAY_OWNER_PROFILE_ID,
        agent,
        space,
        access,
      });
      expect(result.outcome).toBe("applied");
    };
    const turn = async (agent: string, name: string, args: Record<string, unknown>) => {
      activeAgent = agent;
      command = { name, args, issued: false };
      await client!.request(
        "agent",
        {
          agentId: agent,
          sessionKey: "agent:" + agent + ":person-proof",
          message: "Execute the next synthetic proof step.",
          deliver: false,
          idempotencyKey: randomUUID(),
        },
        { expectFinal: true },
      );
      expect(command.issued).toBe(true);
      expect(command.output).toBeTypeOf("string");
      return command.output!;
    };
    const httpTurn = async (
      endpoint: "chat/completions" | "responses",
      name: string,
      args: Record<string, unknown>,
    ) => {
      activeAgent = "research";
      command = { name, args, issued: false };
      const response = await fetch(instance.url.replace("ws:", "http:") + "/v1/" + endpoint, {
        method: "POST",
        headers: {
          authorization: "Bearer " + instance.gatewayToken,
          "content-type": "application/json",
          "x-openclaw-session-key": "agent:research:person-proof",
          "x-openclaw-agent-id": "research",
        },
        body: JSON.stringify({
          model: "openclaw",
          ...(endpoint === "responses"
            ? { input: "Execute the next synthetic proof step." }
            : { messages: [{ role: "user", content: "Execute the next synthetic proof step." }] }),
        }),
      });
      const body = await response.text();
      expect(response.status, body).toBe(200);
      expect(command.issued).toBe(true);
      expect(command.output).toBeTypeOf("string");
      return command.output!;
    };
    try {
      await instance.startGateway();
      client = await connect();
      await assertGatewayAgentsAdmitted(client, ["main", "research"]);
      for (const agentId of ["main", "research"]) {
        const created = await client.request<{ entry: { chatType?: string } }>("sessions.create", {
          key: "agent:" + agentId + ":person-proof",
          agentId,
          label: "Person proof",
          cwd: instance.state.workspaceDir,
        });
        expect(created.entry.chatType).toBe("direct");
      }
      await grant("main", "personal");
      const personalUpload = JSON.parse(
        await turn("main", "knowledge_attach", {
          requestId: randomUUID(),
          filename: "personal.txt",
          attribution: "Synthetic fixture",
          offset: 0,
          data: Buffer.from("Private cedar original").toString("base64"),
          final: true,
        }),
      );
      const personal = await turn("main", "knowledge_save_page", {
        requestId: randomUUID(),
        title: "Private cedar sentinel",
        type: "note",
        body: "Private cedar body.",
        attachments: [personalUpload.evidence],
      });
      expect(personal).toMatch(/"state"\s*:\s*"published"/);
      const id = /"id"\s*:\s*"([a-f0-9-]{36})"/.exec(personal)?.[1];
      expect(id).toBeTruthy();
      await grant("main", "orchid");
      await grant("research", "orchid");
      const projectUpload = JSON.parse(
        await turn("main", "knowledge_attach", {
          requestId: randomUUID(),
          filename: "project.txt",
          attribution: "Synthetic fixture",
          offset: 0,
          data: Buffer.from("Shared orchid original").toString("base64"),
          final: true,
        }),
      );
      const project = await turn("main", "knowledge_save_page", {
        requestId: randomUUID(),
        title: "Shared orchid sentinel",
        type: "note",
        body: "Shared orchid body.",
        attachments: [projectUpload.evidence],
      });
      expect(project).toMatch(/"state"\s*:\s*"published"/);
      expect(await turn("research", "knowledge_records", {})).toContain("Shared orchid sentinel");
      const published = JSON.parse(project);
      const retrieved = JSON.parse(
        await turn("research", "knowledge_record", { id: published.id, includeEvidence: true }),
      );
      expect([retrieved.record.id, retrieved.record.revision, retrieved.record.hash]).toEqual([
        published.id,
        published.revision,
        published.hash,
      ]);
      expect(
        await turn("research", "knowledge_evidence_read", {
          id: published.id,
          path: projectUpload.evidence.path,
          sha256: projectUpload.evidence.sha256,
        }),
      ).toContain("Shared orchid original");
      expect(JSON.parse(await turn("research", "knowledge_record", { id })).record).toBeNull();
      expect(
        JSON.parse(await turn("research", "knowledge_grep", { query: "Private cedar" })).hits,
      ).toEqual([]);
      expect(JSON.parse(await turn("research", "knowledge_lookup", { query: id })).hits).toEqual(
        [],
      );
      for (const name of ["knowledge_evidence_read", "knowledge_attachment"]) {
        const denied = await turn("research", name, {
          id,
          path: personalUpload.evidence.path,
          sha256: personalUpload.evidence.sha256,
        });
        expect(JSON.parse(denied).status).toBe("error");
        expect(denied).not.toContain("Private cedar original");
      }
      // Deliberately request excluded tools: observe actual executor refusals, not prompt/schema filtering.
      for (const [name, args] of [
        ["read", { path: "USER.md" }],
        ["exec", { command: "printf disallowed" }],
        ["process", { action: "list" }],
        ["sessions_history", { sessionKey: "agent:main:person-proof" }],
        ["sessions_search", { query: "Private cedar" }],
        ["personal_instructions", { action: "read" }],
        ["gateway", { action: "config.get" }],
        ["knowledge_history", {}],
        ["knowledge_recent", {}],
        ["knowledge_revision", { sequence: 1 }],
        [
          "knowledge_attach_file",
          {
            requestId: randomUUID(),
            filename: "personal.txt",
            attribution: "Synthetic fixture",
            filePath: "USER.md",
            sha256: "0".repeat(64),
          },
        ],
      ] as const) {
        const denial = await turn("research", name, args);
        expect(denial).toMatch(
          /not (available|found|allowed)|denied|unavailable|unknown tool|not permitted/i,
        );
        expect(denial).not.toContain("Private cedar body.");
      }
      // The same authenticated person and durable direct session must not fall
      // back to legacy partitions when transported through an HTTP adapter.
      await grant("research", "orchid", "read");
      for (const endpoint of ["chat/completions", "responses"] as const) {
        expect(await httpTurn(endpoint, "knowledge_records", {})).toContain(
          "Shared orchid sentinel",
        );
        expect(
          await httpTurn(endpoint, "knowledge_save_page", {
            requestId: randomUUID(),
            title: "Read-only HTTP sentinel",
            type: "note",
            body: "This must not be published.",
          }),
        ).toMatch(/read.only|read only|write/i);
      }
      await grant("research", "orchid", "none");
      expect(await turn("research", "knowledge_records", {})).toMatch(/person.*grant/i);
      for (const endpoint of ["chat/completions", "responses"] as const) {
        expect(await httpTurn(endpoint, "knowledge_records", {})).toMatch(/person.*grant/i);
      }
      const oldPid = instance.child?.pid;
      expect(oldPid).toBeTypeOf("number");
      await disconnectGatewayClient(client);
      client = undefined;
      await instance.stopGateway();
      await instance.startGateway();
      expect(instance.child?.pid).not.toBe(oldPid);
      client = await connect();
      await assertGatewayAgentsAdmitted(client, ["main", "research"]);
      expect(await turn("research", "knowledge_records", {})).toMatch(/person.*grant/i);
      expect(await turn("main", "knowledge_records", {})).toContain("Shared orchid sentinel");
    } finally {
      if (client) {
        await disconnectGatewayClient(client);
      }
      await instance.cleanup();
    }
  },
);
