import { AsyncLocalStorage } from "node:async_hooks";
import type { PluginCohortRecoveryWriteBinding } from "./update-plugin-cohort-schema.js";

export type PluginCohortPublicationContext = PluginCohortRecoveryWriteBinding & {
  env: NodeJS.ProcessEnv;
  assertCurrent: () => void;
};

/** Original admitted updater/Doctor authority; consumers still guard their own effects. */
export const pluginCohortPublicationContext =
  new AsyncLocalStorage<PluginCohortPublicationContext>();
