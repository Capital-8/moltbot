import type { DatabasePathIdentity } from "../infra/sqlite-worker-identity.js";
import { isSqliteWorkerStoreAvailable } from "../infra/sqlite-worker-store.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { Entry, Store } from "./openclaw-state-worker-store.types.js";

const log = createSubsystemLogger("state/worker");

/** Retains one client operation without transferring actor-wide cleanup custody. */
export function createStateWorkerOperationRetainer({
  stores,
  activeEntries,
  clearIdleRetirement,
  refreshPressureSubscription,
  hasActiveActorOperations,
  retireActor,
  retire,
  scheduleIdleRetirement,
}: {
  stores: Set<Entry>;
  activeEntries: Set<Entry>;
  clearIdleRetirement: (entry: Entry) => void;
  refreshPressureSubscription: () => void;
  hasActiveActorOperations: (entry: Entry) => boolean;
  retireActor: (actor: object, identity: DatabasePathIdentity) => Promise<void>;
  retire: (entry: Entry) => Promise<void>;
  scheduleIdleRetirement: (entry: Entry) => void;
}) {
  return (store: Store, onNativeLost?: () => void) => {
    const entry = [...stores].find((candidate) => candidate.store === store);
    if (!entry) {
      throw new Error("Shared-state worker operation lost its actor owner");
    }
    clearIdleRetirement(entry);
    entry.operationGeneration += 1;
    entry.activeOperations += 1;
    activeEntries.add(entry);
    if (onNativeLost) {
      entry.nativeLostListeners.add(onNativeLost);
      if (!isSqliteWorkerStoreAvailable(store)) {
        onNativeLost();
      }
    }
    let released = false;
    return () => {
      if (released) {
        return undefined;
      }
      released = true;
      if (onNativeLost) {
        entry.nativeLostListeners.delete(onNativeLost);
      }
      entry.activeOperations -= 1;
      if (entry.activeOperations === 0) {
        activeEntries.delete(entry);
      }
      refreshPressureSubscription();
      if (
        stores.has(entry) &&
        !isSqliteWorkerStoreAvailable(store) &&
        !hasActiveActorOperations(entry)
      ) {
        // Co-users may await each other's callbacks across maintenance scopes.
        // Only their final release can join actor-wide client closure.
        const pending = entry.actor
          ? retireActor(entry.actor, entry.context.admission.identity)
          : retire(entry);
        void pending.catch((error: unknown) => {
          log.warn("Shared-state worker retirement failed", {
            path: entry.context.admission.databasePath,
            error,
          });
        });
        return pending;
      }
      scheduleIdleRetirement(entry);
      return undefined;
    };
  };
}
