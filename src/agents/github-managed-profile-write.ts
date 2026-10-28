import fs from "node:fs/promises";
import { root as fsRoot } from "@openclaw/fs-safe/root";
import { stringify as stringifyYaml } from "yaml";
import { managedGitHubHosts } from "./github-tool-account.js";
import { notifyManagedGitHubProfileChanged } from "./github-tool-identity-lifecycle.js";

/** Write gh's external file contract without touching its OS keyring or verifying again. */
export async function writeManagedGitHubProfileFiles(
  profileDir: string,
  identity: { login: string; token: string; host?: string },
  options?: { assertCurrent: () => void },
): Promise<void> {
  await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
  await fs.chmod(profileDir, 0o700);
  const profile = await fsRoot(profileDir, { mode: 0o600, mkdir: false, durable: false });
  await profile.write("config.yml", stringifyYaml({ version: "1" }));
  await profile.write("hosts.yml", managedGitHubHosts(identity), {
    assertBeforeMutation: options?.assertCurrent,
  });
  notifyManagedGitHubProfileChanged({ profileDir, kind: "updated" });
}
