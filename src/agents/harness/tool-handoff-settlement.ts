import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { persistPendingFinalDeliveryMarker } from "../pending-final-delivery-marker.js";

/** Command-private custody callback; no persisted authority is inferred from a receipt. */
export type ToolHandoffSettlementCallback = (assertCurrent: () => void) => Promise<void>;
export type RegisterToolHandoffSettlement = (callback: ToolHandoffSettlementCallback) => void;

export function createToolHandoffSettlement() {
  const callbacks = new Set<ToolHandoffSettlementCallback>();
  let settled = false;
  return {
    register: ((callback) => {
      if (settled) {
        throw new Error("Tool handoff custody is already settled");
      }
      callbacks.add(callback);
    }) satisfies RegisterToolHandoffSettlement,
    async settle(assertCurrent: () => void): Promise<void> {
      assertCurrent();
      for (const callback of callbacks) {
        assertCurrent();
        await callback(assertCurrent);
        callbacks.delete(callback);
      }
      settled = true;
    },
  };
}

/** Releases plugin receipts only after the command's result enters durable host custody. */
export async function persistPendingFinalDeliveryWithToolHandoff(
  settlement: ReturnType<typeof createToolHandoffSettlement> | undefined,
  params: Parameters<typeof persistPendingFinalDeliveryMarker>[0] & { assertCurrent: () => void },
) {
  const pendingFinalDeliveryMarker = await persistPendingFinalDeliveryMarker(params);
  const settleToolHandoff = async (hasHostCustody: boolean) => {
    if (!hasHostCustody) {
      return;
    }
    try {
      await settlement?.settle(params.assertCurrent);
    } catch (error) {
      // Cleanup failure retains evidence; it must not turn delivered work into failure.
      createSubsystemLogger("agents/agent-command").warn(
        `Tool handoff cleanup retained evidence: ${formatErrorMessage(error)}`,
      );
    }
  };
  await settleToolHandoff(pendingFinalDeliveryMarker.pendingFinalDeliveryMarkerPersisted);
  return { pendingFinalDeliveryMarker, settleToolHandoff };
}
