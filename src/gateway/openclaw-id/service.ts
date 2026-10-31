// Gateway owner of experimental OpenClaw ID remote access (Labs).
// While the Labs switch is off this module does nothing: it starts no child
// process, opens no sockets and contacts no OpenClaw ID, Discovery or relay
// service. Everything heavier is imported only after the switch turns on.
import type { Server as HttpServer } from "node:http";
import type {
  AuthorityEvent,
  Channel,
  Ed25519PublicKey,
  IrohEndpointKey,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import type { GatewayOpenClawIdConfig } from "../../config/types.gateway.js";
import type {
  AuthorityAccepted,
  AuthorityRefusal,
  LinkCommit,
  LinkPreparation,
  OpenClawIdAuthority,
} from "./authority.js";
import type { PublishOutcome } from "./publisher.js";
import type { TunnelRuntime, TunnelRuntimeSettings } from "./tunnel-runtime.js";
import type { TunnelSupervisorStatus } from "./tunnel-supervisor.js";

/** What the Control UI and `openclaw status` show for OpenClaw ID. */
export type OpenClawIdStatus =
  | { state: "off" }
  | { state: "unconfigured"; missing: Array<keyof GatewayOpenClawIdConfig> }
  | { state: "on"; tunnel: TunnelSupervisorStatus }
  | { state: "failed"; reason: string };

/** Side effects of membership changes that other Gateway owners perform. */
export type OpenClawIdEffects = {
  /** Close Gateway connections relayed for these device keys. */
  disconnectPeers?: (peerKeys: IrohEndpointKey[]) => void;
  /** Invalidate device tokens bound to these device keys. */
  invalidateTokens?: (peerKeys: IrohEndpointKey[]) => Promise<void> | void;
  /** Cancel a removed member's active runs, keeping transcripts up to the cut. */
  cancelRuns?: (accountId: string) => Promise<void> | void;
};

type OpenClawIdLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

/** True only for an explicit `gateway.openclawId.enabled: true`. */
export function isOpenClawIdEnabled(config: GatewayOpenClawIdConfig | undefined): boolean {
  return config?.enabled === true;
}

/** The settings a tunnel runtime needs, or the config keys still missing. */
function resolveSettings(
  config: GatewayOpenClawIdConfig,
  stateDir: string,
): TunnelRuntimeSettings | { missing: Array<keyof GatewayOpenClawIdConfig> } {
  if (!config.relayUrl) {
    return { missing: ["relayUrl"] };
  }
  return {
    stateDir,
    relayUrl: config.relayUrl,
    // Browsers reach a linked claw over the HTTPS loader origin.
    forwardedProto: config.loaderDomain ? "https" : "http",
  };
}

function sameSettings(a: TunnelRuntimeSettings, b: TunnelRuntimeSettings): boolean {
  return (
    a.stateDir === b.stateDir && a.relayUrl === b.relayUrl && a.forwardedProto === b.forwardedProto
  );
}

const refusal = (code: string, detail: string): AuthorityRefusal => ({ ok: false, code, detail });

/** Creates the OpenClaw ID owner. It stays inert until the Labs switch is on. */
export function createOpenClawIdService(params: {
  getConfig: () => GatewayOpenClawIdConfig | undefined;
  getStateDir: () => string;
  /** The Gateway's primary HTTP listener; relayed requests are handed to it. */
  getGatewayServer: () => HttpServer | undefined;
  log: OpenClawIdLogger;
  effects?: OpenClawIdEffects;
  /** Test seam for the persisted authority. */
  createAuthority?: () => Promise<OpenClawIdAuthority>;
}) {
  let status: OpenClawIdStatus = { state: "off" };
  let runtime: TunnelRuntime | undefined;
  let authority: OpenClawIdAuthority | undefined;
  let lastPublish: PublishOutcome | undefined;
  // Serializes start/stop so overlapping config reloads apply in order.
  let queue: Promise<void> = Promise.resolve();

  const getAuthority = async (): Promise<OpenClawIdAuthority> => {
    if (!authority) {
      authority = params.createAuthority
        ? await params.createAuthority()
        : (await import("./authority.js")).createOpenClawIdAuthority();
    }
    return authority;
  };

  const stopRuntime = async () => {
    const current = runtime;
    runtime = undefined;
    await current?.stop();
  };

  const pushMembership = async () => {
    if (!runtime) {
      return;
    }
    const { seq, admitted } = await (await getAuthority()).admittedPeerKeys();
    runtime.pushMembership(seq, admitted);
  };

  const reconcile = async () => {
    const config = params.getConfig();
    if (!config || !isOpenClawIdEnabled(config)) {
      await stopRuntime();
      status = { state: "off" };
      return;
    }
    const settings = resolveSettings(config, params.getStateDir());
    if ("missing" in settings) {
      await stopRuntime();
      status = { state: "unconfigured", missing: settings.missing };
      return;
    }
    if (runtime && sameSettings(runtime.settings, settings)) {
      return;
    }
    await stopRuntime();
    try {
      const { startTunnelRuntime } = await import("./tunnel-runtime.js");
      runtime = await startTunnelRuntime({
        settings,
        gatewayServer: params.getGatewayServer,
        membership: await (await getAuthority()).admittedPeerKeys(),
        log: params.log,
        onStatus: (tunnel) => {
          status = { state: "on", tunnel };
        },
      });
      status = { state: "on", tunnel: runtime.supervisor.status() };
    } catch (error) {
      status = { state: "failed", reason: String((error as Error)?.message ?? error) };
      params.log.warn(`openclaw-id: could not start remote access: ${status.reason}`);
    }
  };

  // Publishes the descriptor and a fresh snapshot; best effort, never authority.
  const publish = async (enrollmentCode?: string): Promise<PublishOutcome | undefined> => {
    const config = params.getConfig();
    const record = (await getAuthority()).current();
    if (!config?.discoveryUrl || !config.relayUrl || !record?.authority) {
      return undefined;
    }
    const [{ publishClaw }, { createDiscoveryClient }, { loadGatewaySigner }] = await Promise.all([
      import("./publisher.js"),
      import("./discovery-client.js"),
      import("./gateway-key.js"),
    ]);
    const { signer } = await loadGatewaySigner(params.getStateDir());
    const outcome = await publishClaw({
      record,
      relayUrl: config.relayUrl,
      client: createDiscoveryClient({ baseUrl: config.discoveryUrl, signer }),
      signer,
      ...(enrollmentCode ? { enrollmentCode } : {}),
    });
    lastPublish = outcome;
    if (outcome.state === "published") {
      await (
        await getAuthority()
      ).recordDiscovery({
        owner_account_id: outcome.ownerAccountId,
        published_binding_seq: record.binding?.body.binding_seq ?? 0,
        published_snapshot_seq: outcome.snapshotSeq,
      });
    } else if (outcome.state === "failed") {
      params.log.warn(`openclaw-id: Discovery publication failed (${outcome.code})`);
    }
    return outcome;
  };

  // Performs the side effects of an accepted write in a fixed order: access first.
  const applyEvents = async (events: AuthorityEvent[]) => {
    await pushMembership();
    for (const event of events) {
      if (event.type === "disconnect") {
        params.effects?.disconnectPeers?.(event.peer_keys);
      } else if (event.type === "invalidate_tokens") {
        await params.effects?.invalidateTokens?.(event.peer_keys);
      } else if (event.type === "cancel_runs") {
        await params.effects?.cancelRuns?.(event.account_id);
      } else if (event.type === "notify_owners") {
        params.log.info(`openclaw-id: owner notice ${event.event}`);
      }
    }
    if (events.some((event) => event.type === "publish_snapshot")) {
      void publish().catch((error: unknown) =>
        params.log.warn(`openclaw-id: publication failed: ${String(error)}`),
      );
    }
  };

  // K_srv of the running tunnel child, needed for the binding.
  const runningServerKey = (): IrohEndpointKey | undefined =>
    status.state === "on" && status.tunnel.state === "running"
      ? (status.tunnel.endpointKey as IrohEndpointKey)
      : undefined;

  return {
    /** Applies the current config: start, reconfigure or stop. */
    reconcileRuntimePolicy(): Promise<void> {
      queue = queue.then(reconcile, reconcile);
      return queue;
    },
    /** Current status; never touches the network. */
    status(): OpenClawIdStatus {
      return status;
    },

    /** Link state for the Control UI: identity, pinned root and membership summary. */
    async linkStatus() {
      if (!isOpenClawIdEnabled(params.getConfig())) {
        return { linked: false as const, publication: undefined };
      }
      const record = await (await getAuthority()).load();
      const state = record?.authority;
      return {
        linked: Boolean(state),
        clawId: record?.claw_id,
        hostname: record?.hostname ?? undefined,
        rootPub: state?.anchor.root_pub,
        rootEpoch: state?.anchor.root_epoch,
        seq: state?.seq,
        ownerDevices: state
          ? Object.values(state.owner_devices).map((device) => ({
              devicePub: device.cert.body.device_pub,
              label: device.cert.body.label,
              peerKeys: device.cert.body.peer_keys,
            }))
          : [],
        members: state
          ? Object.entries(state.members).map(([accountId, member]) => ({
              accountId,
              role: member.role,
              peerKeys: member.peer_keys,
            }))
          : [],
        publication: lastPublish,
      };
    },

    /** Step 1 of "Make reachable": the claw identity and keys the owner root will sign. */
    async prepareLink(channel: Channel | undefined): Promise<LinkPreparation | AuthorityRefusal> {
      if (channel !== "local_operator") {
        return refusal("not_local_operator", "Make reachable only works on this machine");
      }
      const config = params.getConfig();
      if (!isOpenClawIdEnabled(config) || !config?.loaderDomain) {
        return refusal("unconfigured", "set gateway.openclawId.loaderDomain first");
      }
      const kSrv = runningServerKey();
      if (!kSrv) {
        return refusal("tunnel_not_running", "the tunnel is not running yet");
      }
      const { loadGatewaySigner } = await import("./gateway-key.js");
      const { pub } = await loadGatewaySigner(params.getStateDir());
      return await (
        await getAuthority()
      ).prepareLink({ kSrv, kGw: pub, loaderDomain: config.loaderDomain });
    },

    /** Step 2: pin fp(R), admit owner device D1, store the binding, then publish. */
    async commitLink(
      channel: Channel | undefined,
      input: LinkCommit,
      enrollmentCode?: string,
    ): Promise<(AuthorityAccepted & { publication?: PublishOutcome }) | AuthorityRefusal> {
      const kSrv = runningServerKey();
      if (!kSrv) {
        return refusal("tunnel_not_running", "the tunnel is not running yet");
      }
      const { loadGatewaySigner } = await import("./gateway-key.js");
      const { pub: kGw }: { pub: Ed25519PublicKey } = await loadGatewaySigner(params.getStateDir());
      const result = await (await getAuthority()).commitLink(input, channel, { kSrv, kGw });
      if (!result.ok) {
        return result;
      }
      await pushMembership();
      const publication = await publish(enrollmentCode).catch((error: unknown) => {
        params.log.warn(`openclaw-id: publication failed: ${String(error)}`);
        return undefined;
      });
      return { ...result, ...(publication ? { publication } : {}) };
    },

    /** Retries publication, for example with an enrollment code obtained after linking. */
    async publish(enrollmentCode?: string): Promise<PublishOutcome | undefined> {
      return await publish(enrollmentCode);
    },

    /** Applies an owner-signed statement sent directly by a client (never the mailbox). */
    async submitStatement(
      channel: Channel | undefined,
      input: unknown,
    ): Promise<AuthorityAccepted | AuthorityRefusal> {
      if (!channel) {
        return refusal("not_direct", "membership changes come from an owner device on this claw");
      }
      const result = await (await getAuthority()).submit(input, channel);
      if (result.ok) {
        await applyEvents(result.events);
      }
      return result;
    },

    /** Stops everything this owner started. */
    stop(): Promise<void> {
      const stop = async () => {
        await stopRuntime();
        status = { state: "off" };
      };
      queue = queue.then(stop, stop);
      return queue;
    },
  };
}

export type OpenClawIdService = ReturnType<typeof createOpenClawIdService>;
