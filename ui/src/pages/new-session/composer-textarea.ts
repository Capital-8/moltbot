import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { HumanMentionInput } from "../../lib/chat/human-mentions.ts";
import { refreshSlashCommands } from "../../lib/chat/slash-command-catalog.ts";
import {
  disconnectTextareaOverflowObserver,
  observeTextareaOverflow,
  scheduleTextareaHeightAdjustment,
} from "../chat/components/chat-composer-dom.ts";
import { createComposerEmojiMenu } from "../chat/components/chat-composer-emoji-state.ts";
import { createHumanMentionMenu } from "../chat/components/chat-composer-mention-menu-state.ts";
import { createSkillMenu } from "../chat/components/chat-composer-skill-menu-state.ts";
import { createSlashMenu } from "../chat/components/chat-composer-slash-menu-state.ts";
import type { ChatComposerPlusMenuView } from "../chat/composer-capability-types.ts";
import { createDirectDictationTextarea } from "../chat/composer-direct-dictation.ts";

export type NewSessionComposerTextarea = ReturnType<typeof createNewSessionComposerTextarea>;

/** Agent, draft route, and selected project that own one New session command catalog. */
type SkillCommandScope = { agentId: string; draftOwnerKey: string; commandProjectId?: string };

/** Caret and menu mutations stay synchronous for dictation and keyboard handlers. */
export function createNewSessionComposerTextarea() {
  let textarea: HTMLTextAreaElement | null = null;
  let skillCommandClient: GatewayBrowserClient | null = null;
  let skillCommandAgentId = "";
  let skillCommandDraftOwnerKey = "";
  let skillCommandProjectId = "";
  const control = {
    ...createDirectDictationTextarea(() => textarea),
    // An opening gets one cast; typing and async picker updates never reroll it.
    critterVisit: Math.random(),
    skillMenu: createSkillMenu(),
    slashMenu: createSlashMenu(),
    mentionMenu: createHumanMentionMenu(),
    emojiMenu: createComposerEmojiMenu(),
    composing: false,
    // SAFETY: Beforeinput fills this optional selection snapshot.
    mentionInput: undefined as HumanMentionInput | undefined,
    capabilityMenuOpen: false,
    // SAFETY: The closed menu starts at its root; navigation keeps this union.
    capabilityMenuView: "root" as ChatComposerPlusMenuView,
    ref(element?: Element) {
      const nextTextarea = element instanceof HTMLTextAreaElement ? element : null;
      if (textarea && textarea !== nextTextarea) {
        disconnectTextareaOverflowObserver(textarea);
      }
      textarea = nextTextarea;
      if (nextTextarea) {
        observeTextareaOverflow(nextTextarea);
        scheduleTextareaHeightAdjustment(nextTextarea);
      }
    },
    syncDraft(message: string) {
      // Programmatic restores need a measurement after the controlled value commits.
      if (textarea?.isConnected && textarea.value !== message) {
        scheduleTextareaHeightAdjustment(textarea);
      }
    },
    getTextarea: () => textarea,
    syncSkillCommandOwner(client: GatewayBrowserClient | null, scope: SkillCommandScope) {
      if (control.ownsSkillCommands(client, scope)) {
        return;
      }
      // Route, agent, project, or Gateway replacement retires prior async menu results.
      skillCommandClient = client;
      skillCommandAgentId = scope.agentId.trim();
      skillCommandDraftOwnerKey = scope.draftOwnerKey;
      skillCommandProjectId = scope.commandProjectId?.trim() ?? "";
      control.emojiMenu.close();
      control.skillMenu.reset();
      control.slashMenu.reset();
    },
    ownsSkillCommands(client: GatewayBrowserClient | null, scope: SkillCommandScope): boolean {
      return (
        skillCommandClient === client &&
        skillCommandAgentId === scope.agentId.trim() &&
        skillCommandDraftOwnerKey === scope.draftOwnerKey &&
        skillCommandProjectId === (scope.commandProjectId?.trim() ?? "")
      );
    },
    /** Loads the scope's catalog; results apply only while this scope still owns the menus. */
    refreshSkillCommands(client: GatewayBrowserClient, scope: SkillCommandScope) {
      return refreshSlashCommands({
        client,
        agentId: scope.agentId,
        projectId: scope.commandProjectId,
        shouldApply: () => control.ownsSkillCommands(client, scope),
      });
    },
    disconnect() {
      control.skillMenu.dispose();
      control.slashMenu.dispose();
      control.emojiMenu.dispose();
      control.composing = false;
      control.mentionMenu.dispose();
      skillCommandClient = null;
      skillCommandAgentId = "";
      skillCommandDraftOwnerKey = "";
      skillCommandProjectId = "";
      control.capabilityMenuOpen = false;
      control.capabilityMenuView = "root";
      control.ref();
    },
  };
  return control;
}
