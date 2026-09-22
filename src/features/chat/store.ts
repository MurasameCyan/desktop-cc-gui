import { create } from "zustand";
import { ipc, type SessionMeta, type SessionPage } from "@/lib/ipc";
import {
  ENGINE_PREF_KEY,
} from "./store/persistence";
import { readPermissionPref } from "./store/permissions";
import { createTabActions } from "./store/tabs";
import { createMessagingActions } from "./store/messaging";
import { createSessionActions } from "./store/sessions";
import { createWorkspaceActions } from "./store/workspaces";
import { createPreferenceActions } from "./store/preferences";
import { createComposerActions } from "./store/composer";
import type { ChatStore } from "./store/types";

// Facade re-exports: callers keep importing everything from "../store".
export { parseDraftSessionKey, sessionKey } from "./store/persistence";
export type { ActiveSession } from "./store/persistence";
export type { QueuedMessage, SessionState } from "./store/stream";
export type { ChatStore } from "./store/types";
export { effectivePermission } from "./store/permissions";
export { AGENT_BLOCK_HEADER } from "./components/agent-block";
export { sortedWorkspaceGroups } from "./store/session-utils";

/** Unlisteners for the module-scope event subscriptions set up in init. */
const eventTeardowns: Array<() => void> = [];

/** Load a page of session history, routing remote (plugin-fed, e.g. WSL
 *  distro CLI) transcripts through the host's remote fetch instead of the
 *  local db lookup. `meta` is looked up from the current session catalog
 *  when not supplied (usage refresh can't key by workspace). */
function loadHistoryPage(
  engine: string,
  sessionId: string,
  workspacePath: string,
  limit?: number,
  beforeSeq?: number | null,
  meta?: SessionMeta,
): Promise<SessionPage> {
  const m =
    meta ??
    useChatStore
      .getState()
      .sessions.find(
        (s) =>
          s.engine === engine &&
          s.sessionId === sessionId &&
          s.workspacePath === workspacePath,
      );
  if (m?.remote && m.remotePath) {
    return ipc.loadRemoteSessionPage(
      workspacePath,
      engine,
      sessionId,
      m.remotePath,
      limit,
      beforeSeq,
    );
  }
  return beforeSeq === undefined
    ? ipc.loadSessionPage(engine, sessionId, limit)
    : ipc.loadSessionPage(engine, sessionId, limit, beforeSeq);
}

export const useChatStore = create<ChatStore>((set, get) => {
  const {
    activateTab,
    removeTab,
    forgetClosedTab,
    forgetClosedTabs,
    ...tabActions
  } = createTabActions({ set, get });
  const { drainQueue, markUnseenIfBackground, ...messagingActions } =
    createMessagingActions({
      set,
      get,
      loadHistoryPage,
      subscribe: (listener) => useChatStore.subscribe(listener),
    });
  const sessionActions = createSessionActions({
    set,
    get,
    loadHistoryPage,
    eventTeardowns,
    activateTab,
    removeTab,
    forgetClosedTab,
    drainQueue,
    markUnseenIfBackground,
  });
  const workspaceActions = createWorkspaceActions({
    set,
    get,
    activateTab,
    forgetClosedTabs,
  });
  const preferenceActions = createPreferenceActions({
    set,
    get,
  });
  const composerActions = createComposerActions({ set });

  return {
    workspaces: [],
    sessions: [],
    archivedSessionKeys: {},
    engines: [],
    active: null,
    openTabs: [],
    activeEngine: localStorage.getItem(ENGINE_PREF_KEY) ?? "claude",
    permission: readPermissionPref(),
    efforts: {},
    ompServiceTier: null,
    codexServiceTier: null,
    models: {},
    providers: {},
    threadLimit: 10,
    workspaceGroups: [],
    workspaceAliases: {},
    archivedWorkspaces: [],
    sendShortcut: "enter",
    thinkingAutoCollapse: true,
    bySession: {},
    streamingByKey: {},
    unseen: {},
    drafts: {},
    pendingMention: null,
    actionError: null,
    initialized: false,

    ...sessionActions,
    ...workspaceActions,
    ...tabActions,
    ...preferenceActions,
    ...composerActions,
    ...messagingActions,
  };
});

// Dev-only handle for poking the store from the webview console; stripped
// from production builds by the env guard.
if (import.meta.env.DEV) {
  (window as unknown as { __chatStore: typeof useChatStore }).__chatStore =
    useChatStore;
}


// HMR swaps this module for a fresh store; without dispose the old module's
// engine/session listeners keep firing into the dead store (and init on the
// new store would double-subscribe).
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    for (const teardown of eventTeardowns.splice(0)) teardown();
  });
}
