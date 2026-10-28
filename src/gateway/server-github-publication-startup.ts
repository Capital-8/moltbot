import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createGitHubPublicationRuntime } from "./github-publication-runtime.js";
import type { PrepareRepositoryPublicationCheckpoint } from "./repository-publication-checkpoint.js";
import { loadWorkerPlacementSessionRuntimeModule } from "./server-worker-placement-session-target.js";
import type { WorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

export function createGatewayGitHubPublicationRuntime(params: {
  placements: WorkerSessionPlacementStore;
  getCommittedRuntimeConfig: () => OpenClawConfig;
  prepareRepositoryCheckpoint?: PrepareRepositoryPublicationCheckpoint;
  warn: (message: string) => void;
}) {
  return createGitHubPublicationRuntime({
    ...params,
    loadSessionRuntime: loadWorkerPlacementSessionRuntimeModule,
  });
}
