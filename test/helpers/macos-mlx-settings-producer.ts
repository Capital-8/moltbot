// Identical test overlay runs with each revision's own loader and dependencies.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [rawPath, outputPath] = process.argv.slice(2);
assert(rawPath && outputPath && process.env.CI === "true");
assert(process.env.OPENCLAW_PROFILE?.startsWith("test-"));
const state = fs.realpathSync(process.env.OPENCLAW_STATE_DIR!);
const rawURL = fs.realpathSync(rawPath);
assert.equal(rawURL, process.env.OPENCLAW_CONFIG_PATH);
assert.equal(path.dirname(rawURL), state);
assert.equal(path.dirname(path.resolve(outputPath)), state);
assert.equal(os.homedir(), process.env.HOME);
const before = fs.readFileSync(rawURL);
const source = fs.realpathSync(process.cwd());
const load = (relative: string) => import(pathToFileURL(path.join(source, relative)).href);
const paths = await load("src/config/paths.ts");
assert.equal(paths.CONFIG_PATH, rawURL);
const { createConfigIO } = await load("src/config/io.ts");
const { captureRuntimeConfigWithSource } = await load("src/config/runtime-config-capture-state.ts");
const { talkHandlers } = await load("src/gateway/talk/handlers/index.ts");
const { validateTalkConfigResult } = await load("packages/gateway-protocol/src/index.ts");
const snapshot = await createConfigIO({
  configPath: rawURL,
  env: process.env,
  homedir: () => process.env.HOME!,
  observe: false,
}).readConfigFileSnapshot();
assert.equal(snapshot.path, rawURL);
assert.equal(snapshot.exists, true);
assert.equal(snapshot.valid, true);
assert.equal(snapshot.raw, before.toString("utf8"));
const captured = captureRuntimeConfigWithSource(snapshot.config, snapshot.sourceConfig);
let calls = 0;
let payload: unknown;
await talkHandlers["talk.config"]({
  req: { type: "req", id: "mlx-settings-proof", method: "talk.config" },
  params: {},
  client: { connId: "mlx-settings-proof", connect: { scopes: ["operator.read"] } },
  isWebchatConnect: () => false,
  context: { getRuntimeConfig: () => captured },
  respond: (ok: boolean, value: unknown, error: unknown) => {
    calls += 1;
    assert.equal(ok, true);
    assert.equal(error, undefined);
    assert.equal(validateTalkConfigResult(value), true);
    payload = value;
  },
});
assert.equal(calls, 1);
assert.deepEqual(fs.readFileSync(rawURL), before);
assert(payload !== undefined);
fs.writeFileSync(outputPath, JSON.stringify(payload) + "\n", { mode: 0o600 });
console.log(
  JSON.stringify({
    rawSHA256: createHash("sha256").update(before).digest("hex"),
    actualTalkConfigResponses: calls,
  }),
);
