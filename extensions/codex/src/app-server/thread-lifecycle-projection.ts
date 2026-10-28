import { isCodexAppServerLiveThreadBackgroundOnly } from "./client-runtime.js";
import {
  buildCodexPluginAppsConfigPatchFromPolicyContext,
  type CodexPluginThreadConfig,
} from "./plugin-thread-config.js";
import type { CodexAppServerThreadBinding } from "./session-binding.js";
import {
  areCodexDynamicToolFingerprintsCompatible,
  fingerprintCodexThreadConfig,
} from "./thread-fingerprints.js";
import {
  buildCodexThreadRequestConfig,
  prepareCodexThreadFinalConfigPatch,
  type CodexThreadRequestContext,
} from "./thread-lifecycle-preflight.js";
import type { CodexStartOrResumeThreadParams } from "./thread-lifecycle-types.js";

/** Projection identity omits persistent instructions: qualify using warm reuse's full policy. */
export async function canRetainCodexProjectionBackgroundWork(options: {
  params: CodexStartOrResumeThreadParams;
  binding: CodexAppServerThreadBinding;
  preflight: Pick<
    CodexThreadRequestContext,
    "contextEngineBinding" | "dynamicToolsFingerprint" | "legacyDynamicToolsFingerprint"
  >;
  buildLoadedPluginThreadConfig: (
    binding: CodexAppServerThreadBinding,
  ) => Promise<CodexPluginThreadConfig | undefined>;
  prepareRequestContext: () => Promise<CodexThreadRequestContext>;
}): Promise<boolean> {
  const { params, binding } = options;
  const { contextEngineBinding, dynamicToolsFingerprint, legacyDynamicToolsFingerprint } =
    options.preflight;
  // Only a projection refresh can hand the conversation forward while native
  // background work retains its original subscription and cleanup authority.
  if (
    !(
      binding.clientId === params.client.getInstanceId() &&
      binding.contextEngine?.engineId === contextEngineBinding?.engineId &&
      binding.contextEngine?.policyFingerprint === contextEngineBinding?.policyFingerprint &&
      Boolean(contextEngineBinding) &&
      (!binding.dynamicToolsFingerprint ||
        areCodexDynamicToolFingerprintsCompatible({
          previous: binding.dynamicToolsFingerprint,
          next: dynamicToolsFingerprint,
          nextLegacy: legacyDynamicToolsFingerprint,
        })) &&
      isCodexAppServerLiveThreadBackgroundOnly(params.client, binding.threadId)
    )
  ) {
    return false;
  }
  const currentPluginConfig = await options.buildLoadedPluginThreadConfig(binding);
  if (currentPluginConfig && currentPluginConfig.fingerprint !== binding.pluginAppsFingerprint) {
    return false;
  }
  const context = await options.prepareRequestContext();
  const pluginThreadConfig = currentPluginConfig;
  const finalConfig = await prepareCodexThreadFinalConfigPatch(
    params,
    context.nativeModelInputTools,
    binding,
  );
  const pluginConfig =
    pluginThreadConfig?.configPatch ??
    (params.pluginThreadConfig?.enabled && binding.pluginAppPolicyContext
      ? buildCodexPluginAppsConfigPatchFromPolicyContext(binding.pluginAppPolicyContext)
      : undefined);
  const authProfileId =
    binding.connectionScope === "supervision"
      ? undefined
      : (params.params.authProfileId ?? binding.authProfileId);
  const resumeParams = await context.buildResumeParams(
    binding,
    authProfileId,
    buildCodexThreadRequestConfig(params, context, pluginConfig, finalConfig.configPatch),
  );
  return isCodexAppServerLiveThreadBackgroundOnly(
    params.client,
    binding.threadId,
    fingerprintCodexThreadConfig(
      resumeParams,
      authProfileId,
      context.dynamicToolsFingerprint,
      binding,
    ),
  );
}
