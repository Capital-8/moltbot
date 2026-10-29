import { createLazyImportLoader } from "../../../../src/shared/lazy-promise.js";
import { createChangeListeners } from "../../../../src/shared/listeners.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { showToast } from "../../lib/toast.ts";
import type { TemplateCreatorFlow } from "./creator-flow.ts";
import { canCreateTemplateDraft } from "./draft-navigation.ts";

type PendingStart = { agentId: string; client: GatewayBrowserClient; revision: number };
type CreatorOwner = {
  flow: TemplateCreatorFlow | null;
  pending: PendingStart | null;
  loading: boolean;
  subscribe: (listener: () => void) => () => void;
  publish: () => void;
};

const owners = new WeakMap<ApplicationContext, CreatorOwner>();
const runtime = createLazyImportLoader(() => import("./creator-flow.ts"));

/** Dormant chat observes publication without constructing the optional creator runtime. */
export function templateCreatorOwner(context: ApplicationContext): CreatorOwner {
  let owner = owners.get(context);
  if (!owner) {
    owner = { flow: null, pending: null, loading: false, ...createChangeListeners() };
    owners.set(context, owner);
  }
  return owner;
}

async function loadTemplateCreator(context: ApplicationContext, owner: CreatorOwner) {
  // One waiter reads the latest slot after loading; replaced connections must not
  // survive in one suspended async frame per click. Issued writes own their lifetime.
  const result = await runtime.load().then(
    (loaded) => ({ loaded }),
    (error: unknown) => ({ error }),
  );
  owner.loading = false;
  const pending = owner.pending;
  if (!pending) {
    return;
  }
  const { agentId, client, revision } = pending;
  const isCurrent = () =>
    owner.pending === pending &&
    context.gateway.snapshot.client === client &&
    context.gateway.connectionRevision === revision &&
    canCreateTemplateDraft(context);
  try {
    if (isCurrent()) {
      if ("error" in result) {
        throw result.error;
      }
      const flow = result.loaded.templateCreatorFlow(context);
      if (isCurrent()) {
        await flow.start(agentId);
      }
    }
  } catch (error) {
    if (isCurrent()) {
      showToast({
        message: formatUiError(error),
        actionLabel: t("common.retry"),
        onAction: () => startTemplateCreator(context, agentId),
      });
    }
  } finally {
    if (owner.pending === pending) {
      owner.pending = null;
    }
  }
}

function startTemplateCreator(context: ApplicationContext, agentId: string) {
  const client = context.gateway.snapshot.client;
  if (!client || !canCreateTemplateDraft(context)) {
    return;
  }
  const owner = templateCreatorOwner(context);
  const revision = context.gateway.connectionRevision;
  if (
    owner.flow?.busy === "starting" ||
    (owner.pending?.client === client && owner.pending.revision === revision)
  ) {
    return;
  }
  // Claim before yielding; direct route open/start can retire this exact intent.
  owner.pending = { agentId, client, revision };
  if (!owner.loading) {
    owner.loading = true;
    void loadTemplateCreator(context, owner);
  }
}

export function templateCreatorAction(context: ApplicationContext, agentId: string | undefined) {
  if (!agentId || !canCreateTemplateDraft(context)) {
    return undefined;
  }
  return () => startTemplateCreator(context, agentId);
}
