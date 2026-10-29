import { readConfigFileSnapshot } from "../config/io.js";
import { resolveStateDir } from "../config/paths.js";
import type { ConfigFileSnapshot } from "../config/types.js";
import { resolveDatabaseEngineSelection } from "../infra/database-engine/config.js";
import {
  getDatabaseEngineSelection,
  installDatabaseEngineSelection,
  type DatabaseEngineSelection,
} from "../infra/database-engine/context.js";
import { assertDatabasePortStartupAllowed } from "../infra/database-port-recovery.js";
import { setGatewayCredentialEnvKeys } from "../infra/host-env-security.js";

/** Direct servers and embedded kernels enter before locks, state reads, or plugin config. */
export async function installGatewayDatabaseEngine(
  snapshot?: ConfigFileSnapshot,
  selection?: DatabaseEngineSelection,
): Promise<void> {
  assertDatabasePortStartupAllowed(resolveStateDir(process.env));
  let installed = getDatabaseEngineSelection();
  if (selection) {
    installDatabaseEngineSelection(selection);
    installed = selection;
  }
  if (!installed) {
    const selected =
      snapshot ??
      (await readConfigFileSnapshot({
        observe: false,
        isolateEnv: true,
        pluginValidation: "core-only",
      }));
    installed = await resolveDatabaseEngineSelection(selected.config);
    installDatabaseEngineSelection(installed);
  }
  setGatewayCredentialEnvKeys(
    "database.postgres.connection",
    installed.postgres?.connectionEnvKey ? [installed.postgres.connectionEnvKey] : [],
  );
}
