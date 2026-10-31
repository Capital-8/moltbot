import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enLabs = {
  labsPage: {
    swarm: {
      title: en.labsPage.swarm.title,
      groupTitle: "Parallel tasks",
      defaultPhase: en.labsPage.swarm.defaultPhase,
      progress: "{complete} of {total}",
      active: "{running} running · {queued} queued · {failed} failed or stopped",
      finished: "{done} completed · {failed} failed or stopped",
      completed: "{done} completed",
      failedOrStopped: "Failed or stopped",
      childOutcome: "Child runs finished. Check the conversation for the final response.",
      childOutcomeProcessing: "Child runs finished. The parent is processing their results.",
      details: "Child details",
      detailsUnavailable: "Child details are unavailable. Counts include all accepted workers.",
      otherGroups: "{count} more active groups",
    },
    configure: "Configure",
    configureFeature: "Configure {name}",
    decisionAssistance: {
      title: "Decision assistance",
      description:
        "Enable experimental assistance from your configured Decision model. See the documentation for supported uses, setup, and data handling.",
      optedIn: "Preference saved.",
      loading: "Loading setting…",
      unavailable: "Couldn’t load this setting. Reconnect or refresh to try again.",
      refresh: "Refresh configuration",
    },
    codeMode: {
      title: "Code Mode",
      description:
        "Set the global default for compact JavaScript tool workflows. On selects Auto for evaluated models; Off disables the default. Per-model Code Mode overrides are in Agent Defaults → Models (Advanced).",
      executor: "Code Mode executor",
      executorDescription:
        "Node.js is for trusted code; its VM is not a security sandbox. QuickJS runs code in an isolated WebAssembly runtime. Calls through OpenClaw tools use the same permissions. Applies to new runs; agent overrides take precedence.",
      executorNode: "Node.js (default)",
      executorQuickjs: "QuickJS (isolated)",
    },
    toolSearch: {
      title: "Tool Search for all models",
      description:
        "Defer tool schemas and discover tools on demand. Enabled by default with structured tool calls; turning it off disables the global default.",
    },
    advisor: {
      title: "Advisor",
      description:
        "Advisor reviews the conversation on the session's own model every few tool calls or minutes. If the agent is going off course, it steers the active run with one short correction. Adds model calls.",
    },
    composerPredictions: {
      title: "Composer predictions",
      description:
        "Suggest a next message after a reply in the active conversation. Adds a tool-free model call using conversation context. Tab accepts the suggestion into your draft; it never sends automatically. Off by default.",
      model: "Prediction model",
      modelDescription:
        "Utility is recommended for short, lower-cost predictions. Conversation uses the current chat model; Default uses the agent's configured primary model. An unavailable choice skips predictions instead of switching models.",
      utility: "Utility model (recommended)",
      conversation: "Conversation model",
      default: "Default model",
    },
    chatBubbles: {
      title: "Speech bubbles",
      description:
        "Try speech bubbles with compact tool activity. Home uses bubbles by default while enabled; each browser keeps its explicit conversation choices. Disabling this lab restores the standard view without clearing those choices.",
    },
    templates: {
      title: "Templates",
      description: "Templates are ready-made agents for specific tasks.",
    },
    hostDesktop: {
      title: "Host Desktop",
      description:
        "Watch and control this Gateway machine from the Desktop panel through its existing VNC or Screen Sharing server.",
    },
    openclawId: {
      title: "OpenClaw ID remote access",
      description:
        "Reach this Gateway from your other devices through OpenClaw ID, without opening a port. Off by default; while off the Gateway starts no tunnel and contacts no OpenClaw ID service.",
      statusTitle: "Remote access status",
      tunnelTitle: "Tunnel",
      serverKey: "Server key {fingerprint}",
      off: "Off",
      stopped: "Stopped",
      starting: "Starting…",
      running: "Online · {count} connections",
      relayOffline: "Running · relay not reachable yet",
      restarting: "Restarting after {exit}",
      unconfigured: "Needs {keys}",
      notLinkedTitle: "Not reachable yet",
      notLinkedDescription:
        "Make this claw reachable from your other devices. You'll create a recovery kit that proves you own it.",
      needsLoaderDomain:
        "Set gateway.openclawId.loaderDomain to choose the address this claw is reachable at.",
      localOnly:
        "Open the Control UI on this machine (127.0.0.1) to make it reachable. Linking never runs over a remote connection.",
      makeReachable: "Make reachable",
      reachableTitle: "Reachable",
      reachableDescription: "{owners} owner devices · {members} members",
      ownerTitle: "Owner fingerprint",
      ownerDescription: "Matches the fingerprint printed on your recovery kit.",
      discoveryTitle: "OpenClaw ID listing",
      publication: {
        published: "Published",
        needs_enrollment_code: "Not published",
        failed: "Publishing failed",
      },
      actionFailed: "Couldn't make this claw reachable",
      dialogTitle: "Make this claw reachable",
      dialogDescription: "Create a recovery kit and link this claw to it.",
      introBody: "This claw will be reachable at https://{host} from devices you approve.",
      introKit:
        "First you'll get a recovery kit. It is the only way to prove you own your claws if you lose your devices, so save it somewhere safe, like your password manager.",
      createKit: "Create recovery kit",
      kitBody: "This is your recovery kit. It is shown once.",
      kitFingerprint: "Owner fingerprint: {fingerprint}",
      kitWarning:
        "Anyone with this kit can take ownership of your claws. Never share it or read it to anyone.",
      downloadKit: "Download as text file",
      enrollmentCode: "OpenClaw ID enrollment code (optional)",
      enrollmentCodeHint: "Lists this claw in your OpenClaw ID account. You can add it later.",
      kitSaved: "I saved my recovery kit somewhere safe",
      thisBrowser: "This browser",
      linking: "Linking this claw…",
      doneBody: "This claw is now linked to your recovery kit and reachable at https://{host}.",
      doneNotPublished:
        "It is not listed in OpenClaw ID yet. Add an enrollment code to publish it.",
      done: "Done",
      enrollmentCodePlaceholder: "Enrollment code",
      publish: "Publish",
      memberDescription: "{role} · {devices} devices",
      remove: "Remove",
      removing: "Removing…",
      removeFailed: "Couldn't remove this member",
      noOwnerKey:
        "This browser has no owner device key for this claw. Remove members from an owner device.",
      unavailableRetry:
        "Remote access needs the iroh binding for this platform. The Gateway checks again every minute.",
      invites: {
        title: "Invite someone",
        description:
          "They sign in with OpenClaw ID, then you approve them here. Invites expire after 7 days.",
        email: "Email address to invite",
        emailPlaceholder: "name@example.com",
        role: "Role",
        operator: "Operator",
        viewer: "Viewer",
        create: "Create invite",
        copy: "Copy invite link",
        linkTitle: "Invite link for {email}",
        linkDescription:
          "Send it to them privately. Anyone with the link can ask to join, and nobody gets in until you approve. Expires {date}.",
        openDescription: "{role} · waiting to be redeemed · expires {date}",
        waiting: "Invited",
        pendingTitle: "{name} wants to join as {role}",
        pendingDescription: "{email} · {location} · as reported by OpenClaw ID · decide by {date}",
        unknownLocation: "location unknown",
        approve: "Approve",
        deny: "Deny",
        failed: "Couldn't update invites",
        noOwnerKey:
          "This browser has no owner device key for this claw. Manage invites from an owner device.",
      },
    },
    workerDesktop: {
      title: "Cloud Worker Desktop",
      description:
        "Watch and control node-carried desktops from capable Crabbox AWS, Azure, or Hetzner profiles with desktop: true.",
    },
  },
} satisfies TranslationMap;

export const registerLabsEnglish = Object.assign(
  () => {
    const { swarm, ...labsPage } = enLabs.labsPage;
    Object.assign(en.labsPage, labsPage);
    Object.assign(en.labsPage.swarm, swarm);
  },
  { catalog: enLabs },
);
