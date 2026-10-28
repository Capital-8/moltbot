/** Exact command identity fences a placement to its enrolled model configuration. */
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { parse as parseToml } from "smol-toml";

const PREFIX = "codex.app-server.stdio.v1";

/** Availability and execution consume the same enrolled command-auth contract. */
export function resolveCodexWorkerAuthHelper(config: string, directory: string): string {
  let native: unknown;
  try {
    native = parseToml(config);
  } catch {
    throw new Error("Cloud worker Codex configuration is invalid");
  }
  const providerId = isRecord(native) ? native.model_provider : undefined;
  const providers = isRecord(native) ? native.model_providers : undefined;
  const provider =
    typeof providerId === "string" && isRecord(providers) ? providers[providerId] : undefined;
  const selected = isRecord(provider) ? provider : undefined;
  const auth = isRecord(selected?.auth) ? selected.auth : undefined;
  const helper = Array.isArray(auth?.args) && auth.args.length === 1 ? auth.args[0] : undefined;
  if (
    selected?.wire_api !== "responses" ||
    auth?.command !== "node" ||
    typeof helper !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*\.mjs$/.test(path.basename(helper)) ||
    path.join(directory, path.basename(helper)) !== helper ||
    ["env_key", "experimental_bearer_token", "requires_openai_auth"].some((key) =>
      Object.hasOwn(selected, key),
    )
  ) {
    throw new Error("Cloud worker Codex command-auth provider is incomplete");
  }
  return helper;
}

export function resolveCodexWorkerAppServerCommand(
  env: NodeJS.ProcessEnv = process.env,
  required = false,
): string {
  const configured = env.OPENCLAW_WORKER_CODEX_CONFIG_VERSION;
  let enrolled: string | undefined;
  if (env.OPENCLAW_STATE_DIR || env.OPENCLAW_WORKER_CODEX_CONFIG_VERSION) {
    try {
      enrolled = fs.readFileSync(
        path.join(resolveStateDir(env), "codex-runtime", "version"),
        "utf8",
      );
    } catch {
      /* Gateway and other nodes have no worker lease config. */
    }
  }
  const version = enrolled ?? configured;
  if (!version) {
    if (required) {
      throw new Error("Worker Codex configuration version is unavailable");
    }
    return PREFIX;
  }
  if (!/^[a-f0-9]{64}$/.test(version) || (enrolled && configured && enrolled !== configured)) {
    throw new Error("Worker Codex configuration version is invalid or mismatched");
  }
  return `${PREFIX}.${version}`;
}
