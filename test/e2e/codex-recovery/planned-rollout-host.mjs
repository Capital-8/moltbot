import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { acquireTestPortBlock } from "../../../src/test-utils/port-claims.ts";

async function readExecutorEffort(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  try {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("executor config probe timed out")), 8000);
      ws.addEventListener("close", () => {
        clearTimeout(timeout);
        reject(new Error("executor probe closed"));
      });
      ws.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("executor probe failed"));
      });
      ws.addEventListener("open", () =>
        ws.send(
          JSON.stringify({
            id: 1,
            method: "initialize",
            params: { clientInfo: { name: "rollout-fixture", version: "1" } },
          }),
        ),
      );
      ws.addEventListener("message", ({ data }) => {
        const msg = JSON.parse(data);
        if (msg.error) {
          clearTimeout(timeout);
          reject(new Error(msg.error.message));
          return;
        }
        if (msg.id === 1) {
          ws.send(JSON.stringify({ method: "initialized" }));
          ws.send(
            JSON.stringify({ id: 2, method: "config/read", params: { includeLayers: false } }),
          );
        } else if (msg.id === 2) {
          clearTimeout(timeout);
          resolve(msg.result.config.model_reasoning_effort);
        }
      });
    });
  } finally {
    ws.close();
  }
}

export async function preparePlannedRolloutFixture({
  root,
  repo,
  env,
  binary,
  log,
  children,
  claims,
}) {
  const { advancePlannedRollout, runPlannedRollout, MAX_BUSY_WAIT_MS } = await import(
    pathToFileURL(process.env.OC_ROLLOUT_DRIVER).href
  );
  const block = await acquireTestPortBlock({ offsets: [0, 1] });
  claims.push(block);
  const peer = path.join(root, "idle-peer");
  fs.mkdirSync(peer + "/home", { recursive: true });
  fs.writeFileSync(
    peer + "/config.json",
    JSON.stringify({
      gateway: { mode: "local" },
      plugins: { enabled: false },
      logging: { file: peer + "/gateway.log" },
    }),
  );
  const peerEnv = {
    ...env,
    HOME: peer + "/home",
    OPENCLAW_STATE_DIR: peer + "/home/.openclaw",
    OPENCLAW_CONFIG_PATH: peer + "/config.json",
    OC_REPRO_GATEWAY_PORT: String(block.port),
  };
  const args = [
    "--import",
    repo + "/test/e2e/codex-recovery/repro-dns.mjs",
    "--import",
    repo + "/scripts/tsx.mjs",
    repo + "/test/e2e/codex-recovery/planned-rollout-process.mts",
  ];
  const listen = async (kind, childEnv) => {
    const out = fs.openSync(path.join(root, "rollout-host.log"), "a");
    const child = spawn(process.execPath, [...args, kind], {
      cwd: repo,
      env: childEnv,
      stdio: ["ignore", out, out, "ipc"],
    });
    fs.closeSync(out);
    children.push(child);
    const ready = await Promise.race([
      once(child, "message").then(([m]) => m.ready),
      once(child, "exit").then(([code]) => {
        throw new Error("rollout fixture startup failed " + code);
      }),
    ]);
    assert.equal(ready, true);
    return child;
  };
  const startExecutor = async (execPort, home) => {
    const child = spawn(binary, ["app-server", "--listen", `ws://127.0.0.1:${execPort}`], {
      env: { ...env, HOME: home, CODEX_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    await new Promise((resolve, reject) => {
      let lines = "";
      const check = (data) => {
        lines = (lines + data.toString()).slice(-4096);
        if (lines.includes("listening on:")) {
          resolve();
        }
      };
      child.stdout.on("data", check);
      child.stderr.on("data", check);
      child.once("exit", () => reject(new Error("executor exited before listening")));
    });
    return child;
  };
  const client = await listen("client", env);
  let rpcId = 0;
  const call =
    (port) =>
    (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++rpcId;
        const recv = (r) => {
          if (r.id !== id) {
            return;
          }
          client.off("message", recv);
          if (r.error) {
            reject(new Error(r.error));
          } else {
            resolve(r.result);
          }
        };
        client.on("message", recv);
        client.send({ id, port, method, params });
      });
  const peerGateway = await listen("gateway", peerEnv);
  const peerExecutor = await startExecutor(block.port + 1, peer + "/home");
  const stop = async (child) => {
    const exited = once(child, "exit");
    assert.ok(child.kill("SIGTERM"));
    await exited;
  };
  return async ({
    gateway,
    executor,
    port,
    releaseTool,
    expiredCase,
    resultReady,
    verifyBusyHandoff,
  }) => {
    const receipts = [];
    const requestedAtMs = Date.now() - (expiredCase ? MAX_BUSY_WAIT_MS - 15_000 : 0);
    const tenant = async (name, gw, ex, gwPort, exPort, gatewayEnv, nativeHome) => {
      const rpc = async (method, params) => {
        const result = await call(gwPort)(method, params);
        if (result.status === "busy") {
          log("rollout-blockers", { name, blockers: result.blockers });
        }
        return result;
      };
      const info = await rpc("system.info");
      assert.equal(info.pid, gw.pid);
      const target = { pid: info.pid, processInstanceId: info.processInstanceId };
      const operation = { requestId: "test-release-" + name, target, requestedAtMs };
      // Publish candidate bytes without touching the running generations.
      const oldConfig = JSON.parse(fs.readFileSync(gatewayEnv.OPENCLAW_CONFIG_PATH, "utf8"));
      const nextConfig = {
        ...oldConfig,
        agents: {
          ...oldConfig.agents,
          defaults: {
            ...oldConfig.agents?.defaults,
            thinkingDefault: "high",
          },
        },
      };
      const nextConfigPath = path.join(root, name + "-successor.json");
      fs.writeFileSync(nextConfigPath, JSON.stringify(nextConfig));
      const codexConfig = path.join(nativeHome, "config.toml");
      const previousToml = fs.existsSync(codexConfig) ? fs.readFileSync(codexConfig, "utf8") : "";
      assert.ok(!/^model_reasoning_effort\s*=/m.test(previousToml));
      const nextCodexConfig = path.join(root, name + "-successor.toml");
      fs.writeFileSync(nextCodexConfig, 'model_reasoning_effort = "high"\n' + previousToml);
      assert.notEqual(
        (await rpc("config.get", {})).config.agents?.defaults?.thinkingDefault,
        "high",
      );
      assert.notEqual(await readExecutorEffort(exPort), "high");
      log("rollout-candidates-staged", { name, gateway: gw.pid, executor: ex.pid });
      const cutover = async (original, expiresAt) => {
        assert.equal(gw.pid, original.pid);
        assert.ok(Date.now() < expiresAt);
        if (name === "busy") {
          assert.equal(resultReady(), !expiredCase, "unexpected original delivery at cutover");
          assert.ok(!expiredCase || Date.now() >= requestedAtMs + MAX_BUSY_WAIT_MS);
        }
        log("rollout-stop-original", { name, gatewayPid: gw.pid, executorPid: ex.pid });
        await stop(gw);
        if (name === "busy") {
          assert.ok(resultReady(), "executor stop preceded original delivery");
        }
        await stop(ex);
        fs.renameSync(nextCodexConfig, codexConfig);
        const nextEx = await startExecutor(exPort, nativeHome);
        const nextGw = await listen("gateway", {
          ...gatewayEnv,
          OPENCLAW_CONFIG_PATH: nextConfigPath,
          OC_REPRO_GATEWAY_PORT: String(gwPort),
        });
        const nextInfo = await rpc("system.info");
        const gatewayConfig = await rpc("config.get", {});
        assert.equal(gatewayConfig.config.agents.defaults.thinkingDefault, "high");
        const executorConfig = await readExecutorEffort(exPort);
        assert.equal(executorConfig, "high");
        assert.equal(nextInfo.pid, nextGw.pid);
        assert.notEqual(nextEx.pid, ex.pid);
        assert.notEqual(nextGw.pid, gw.pid);
        assert.notEqual(info.processInstanceId, nextInfo.processInstanceId);
        receipts.push({
          name,
          before: [gw.pid, ex.pid],
          after: [nextGw.pid, nextEx.pid],
          gatewayThinking: "high",
          executorEffort: executorConfig,
          at: Date.now(),
        });
      };
      return (watch = false) =>
        (watch ? runPlannedRollout : advancePlannedRollout)({ operation, call: rpc, cutover });
    };
    const busy = await tenant(
      "busy",
      gateway,
      executor,
      port,
      port - 1,
      env,
      root + "/native-home",
    );
    const idle = await tenant(
      "idle",
      peerGateway,
      peerExecutor,
      block.port,
      block.port + 1,
      peerEnv,
      peer + "/home",
    );
    const first = await busy();
    assert.equal(first.status, "waiting");
    assert.equal(first.reason, "active-work");
    log("rollout-busy-deferred", first);
    await verifyBusyHandoff();
    const [busyState] = await Promise.all([
      busy(true),
      (async () => {
        assert.equal((await idle(true)).status, "updated");
        if (!expiredCase) {
          assert.ok(!resultReady() && gateway.exitCode === null && executor.exitCode === null);
          log("peer-updated-original-still-live", { gateway: gateway.pid, executor: executor.pid });
          // Both changes have been pending longer than the supervisor stop window.
          await sleep(Math.max(0, requestedAtMs + 11_000 - Date.now()));
          assert.ok(!resultReady());
          releaseTool();
        }
      })(),
    ]);
    assert.equal(busyState.status, "updated");
    assert.equal(busyState.reason, expiredCase ? "deadline" : "idle");
    log("rollout-applied", busyState);
    assert.deepEqual(
      expiredCase ? receipts.map((r) => r.name).toSorted() : receipts.map((r) => r.name),
      expiredCase ? ["busy", "idle"] : ["idle", "busy"],
    );
    fs.writeFileSync(
      root + "/planned-rollout.json",
      JSON.stringify({ requestedAtMs, first, receipts }, null, 2),
    );
  };
}
