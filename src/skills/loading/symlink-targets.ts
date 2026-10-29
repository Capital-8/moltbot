import {
  normalizeTrimmedStringList,
  uniqueStrings,
} from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveIdentityPathViaExistingAncestorSync,
  safeRealpathSync,
} from "../../infra/boundary-path.js";
import { resolveUserPath } from "../../utils.js";

export function resolveAllowedSkillSymlinkTargetRealPaths(config?: OpenClawConfig): string[] {
  const targetPaths = normalizeTrimmedStringList(config?.skills?.load?.allowSymlinkTargets)
    .map((dir) => tryRealpath(resolveUserPath(dir)))
    .filter((dir): dir is string => Boolean(dir));
  return uniqueStrings(targetPaths);
}

export function tryRealpath(filePath: string): string | null {
  try {
    // Kernel realpath adopts on-disk casing (fs-safe 0.26.5's sync ancestor
    // resolver keeps input casing), then require an existing path.
    return safeRealpathSync(resolveIdentityPathViaExistingAncestorSync(filePath));
  } catch {
    return null;
  }
}
