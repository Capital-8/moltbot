import { stableStringify } from "@openclaw/normalization-core";
import type { ProgressCard } from "../../../packages/gateway-protocol/src/index.js";

// The execution wrapper records the raw result before presentation or serialization.
// Keep semantic card state private: revisions must still acknowledge unchanged refreshes.
const outcomes = new WeakMap<object, string>();

export function recordProgressCardToolOutcome<T extends object>(
  result: T,
  card: ProgressCard | null,
  work?: import("../../session-cards/progress-card-work-intent.js").WorkSnapshot,
): T {
  outcomes.set(
    result,
    stableStringify({
      markdown: card?.markdown ?? null,
      steps: card?.steps ?? null,
      work:
        work?.kind === "retained"
          ? {
              scope: work.state.record?.scope,
              steps: work.state.record?.steps,
              disposition: work.state.record?.disposition.kind,
              hold:
                work.state.record?.disposition.kind === "paused-blocked"
                  ? {
                      reason: work.state.record.disposition.reason,
                      resumeCondition: work.state.record.disposition.resumeCondition,
                    }
                  : undefined,
            }
          : null,
    }),
  );
  return result;
}

export function getProgressCardToolOutcome(result: object): string | undefined {
  return outcomes.get(result);
}
