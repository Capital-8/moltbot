import { AsyncResource } from "node:async_hooks";
import { embeddedAgentLog, formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexAttemptNotificationController } from "./run-attempt-notification-controller.js";
import { recoverCodexAttemptConnection } from "./run-attempt-recovery.js";
import type { CodexAttemptResources } from "./run-attempt-resources.js";
import type { createCodexAttemptServerRequestController } from "./run-attempt-server-requests.js";
import type { CodexAttemptTurnState } from "./run-attempt-turn-state.js";
import type { CodexThreadRouteReservation } from "./turn-router.js";

export async function prepareCodexAttemptRoute(
  resources: CodexAttemptResources,
  turnRuntime: CodexAttemptTurnState,
  notifications: CodexAttemptNotificationController,
  handleServerRequest: ReturnType<
    typeof createCodexAttemptServerRequestController
  >["handleServerRequest"],
) {
  const {
    prompt,
    state: resourceState,
    trajectoryRecorder,
    releaseCurrentRoute,
    registerNativeSubagentMonitor,
  } = resources;
  const { connection } = prompt.context.runtime;
  const { runAbortController } = connection;
  const { state, turnIdRef, completeTurn } = turnRuntime;
  const { noteNotificationReceived, enqueueNotification } = notifications;
  const attachRouteAbort = (route: CodexThreadRouteReservation) => {
    // The shared socket can have been created by an already completed attempt.
    const onAbort = AsyncResource.bind(() => {
      if (
        state.completed ||
        state.terminalTurnNotificationQueued ||
        runAbortController.signal.aborted ||
        state.connectionRecovery
      ) {
        return;
      }
      const reasonText = formatErrorMessage(route.signal.reason);
      const closedClient = reasonText.includes("turn router closed");
      const closeCause =
        route.signal.reason instanceof Error && route.signal.reason.cause instanceof Error
          ? route.signal.reason.cause
          : undefined;
      const fail = (error?: unknown) => {
        state.clientClosedPromptError = closedClient
          ? "codex app-server client closed before turn completed"
          : `codex app-server turn route closed before turn completed: ${reasonText}`;
        state.clientClosedDiagnostic = error
          ? formatErrorMessage(error)
          : closedClient && closeCause
            ? formatErrorMessage(closeCause)
            : undefined;
        state.clientClosedAbort = closedClient;
        const activeTurnId = turnIdRef.current;
        if (activeTurnId) {
          trajectoryRecorder?.recordEvent("turn.client_closed", {
            threadId: resourceState.thread.threadId,
            turnId: activeTurnId,
          });
        }
        embeddedAgentLog.warn(state.clientClosedPromptError, {
          threadId: resourceState.thread.threadId,
          turnId: activeTurnId,
          ...(state.clientClosedDiagnostic ? { transportError: state.clientClosedDiagnostic } : {}),
        });
        runAbortController.abort(closedClient ? "client_closed" : "turn_route_closed");
        completeTurn();
      };
      if (
        closedClient &&
        resourceState.acquireRecoveryClient &&
        turnIdRef.current &&
        !state.connectionRecovery
      ) {
        trajectoryRecorder?.recordEvent("turn.connection_recovering", {
          threadId: resourceState.thread.threadId,
          turnId: turnIdRef.current,
        });
        state.connectionRecovery = recoverCodexAttemptConnection(
          resources,
          turnRuntime,
          notifications,
          route,
          activateRoute,
        )
          .catch((error: unknown) => {
            resourceState.remoteRecoveryFailed = true;
            if (!runAbortController.signal.aborted && !state.completed) {
              fail(error);
            }
          })
          .finally(() => {
            state.connectionRecovery = undefined;
            // Closure can queue after the helper's final check but before this
            // promise clears. No closed replacement may retain the active owner.
            if (
              !state.completed &&
              !state.terminalTurnNotificationQueued &&
              !runAbortController.signal.aborted &&
              resourceState.client.getCloseError()
            ) {
              resourceState.remoteRecoveryFailed = true;
              fail(resourceState.client.getCloseError());
            }
          });
        return;
      }
      if (closedClient && resourceState.acquireRecoveryClient && !turnIdRef.current) {
        // An acknowledged turn is required for reconnection. A lost start response
        // leaves execution uncertain, so isolate it instead of replaying the prompt.
        resourceState.remoteRecoveryFailed = true;
      }
      fail();
    });
    route.signal.addEventListener("abort", onAbort, { once: true });
    if (route.signal.aborted) {
      onAbort();
    }
    return () => route.signal.removeEventListener("abort", onAbort);
  };
  const activateRoute = async (route: CodexThreadRouteReservation) => {
    resourceState.detachRouteAbort = attachRouteAbort(route);
    await route.activate({
      onNotificationReceived: noteNotificationReceived,
      onNotification: async (...args) => {
        await state.liveRejoinAdmission?.promise;
        return await enqueueNotification(...args);
      },
      onRequest: async (...args) => {
        await state.liveRejoinAdmission?.promise;
        return await handleServerRequest(...args);
      },
    });
    resourceState.routeActivated = true;
  };
  const ensureCurrentThreadRoute = async () => {
    if (resourceState.turnRoute?.threadId !== resourceState.thread.threadId) {
      await releaseCurrentRoute();
      resourceState.turnRoute = resourceState.turnRouter.reserveThread({
        threadId: resourceState.thread.threadId,
      });
    }
    if (!resourceState.routeActivated) {
      if (!resourceState.nativeSubagentMonitor) {
        await registerNativeSubagentMonitor(resourceState.thread.threadId);
      }
      await activateRoute(resourceState.turnRoute);
    }
    return resourceState.turnRoute;
  };
  await ensureCurrentThreadRoute();
  return { ensureCurrentThreadRoute };
}
