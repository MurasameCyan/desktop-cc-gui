import { ipc, type Message, type SessionMeta, type TodosPayload } from "@/lib/ipc";
import type { EngineEventPayload } from "@/lib/events";
import { dedupeTabs, persistTabs, sessionKey } from "./persistence";
import {
  EMPTY_SESSION,
  appendToolMessage,
  applyStreamParts,
  bufferStreamPart,
  drainPending,
  migratePendingStream,
  moveStreamingFlag,
  patchSession,
  resolveSessionModel,
  runRouting,
  scheduleDeltaFlush,
  setStreamingFlag,
  settleLiveRows,
  updatePendingStreamModel,
} from "./stream";
import type { ChatStore } from "../store";
import { mergeUsage, parseUsage } from "../usage";
import { usageTrackingEnabled } from "@/features/settings/usage-tracking";

/**
 * Engine-event handling: the main loop resolves each event's session key and
 * dispatches to one handler per event kind. Store-agnostic apart from the
 * ChatStore type (type-only import, so no runtime cycle with store.ts);
 * everything the handlers need arrives through EngineEventDeps.
 */

export interface EngineEventDeps {
  set: (fn: (s: ChatStore) => Partial<ChatStore>) => void;
  get: () => ChatStore;
  /** After a turn ends, send the oldest queued message for that session. */
  drainQueue: (key: string) => void;
  /** Flag a finished background session for the sidebar's unseen dot. */
  markUnseenIfBackground: (key: string) => void;
  /** Insert/bump a freshly created session in the sidebar list cache. */
  upsertSessionMeta: (meta: SessionMeta) => void;
  /** Re-fetch the latest token usage from session history for the given session key. */
  refreshSessionUsage?: (key: string) => Promise<void>;
}

/** Collapse whitespace and cap a prompt for use as a session title. */
export function firstLineTitle(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 40);
}

/** List-cache entry for a session the backend scanner has not seen yet. */
export function optimisticMeta(
  engine: string,
  sessionId: string,
  workspacePath: string,
  title: string,
): SessionMeta {
  const now = Date.now();
  return {
    engine,
    sessionId,
    workspacePath,
    filePath: "",
    fileSize: 0,
    fileMtimeMs: 0,
    title,
    preview: "",
    createdAt: now,
    updatedAt: now,
    messageCount: 1,
    pinned: false,
    customTitle: null,
  };
}

/** Insert a freshly created session into the sidebar list cache (or bump its
 * timestamp when already present). Without this the row and the tab title
 * stayed missing/"新对话" until the post-turn rescan completed. */
export function upsertSessionMetaInto(
  set: (fn: (s: ChatStore) => Partial<ChatStore>) => void,
  meta: SessionMeta,
) {
  set((s) => {
    const idx = s.sessions.findIndex(
      (x) => x.engine === meta.engine && x.sessionId === meta.sessionId,
    );
    if (idx < 0) return { sessions: [meta, ...s.sessions] };
    const sessions = s.sessions.slice();
    sessions[idx] = { ...sessions[idx], updatedAt: meta.updatedAt };
    return { sessions };
  });
}

/** Effective model for event-stamped rows: the session's activeModel wins,
 * followed by the owning tab's per-tab override, then the session's own
 * history, then the engine default — the same resolveSessionModel the send
 * path uses, so a row can never claim a model the turn did not run. */
function stampedModel(
  deps: EngineEventDeps,
  engine: string,
  key: string,
): string | null {
  const s = deps.get();
  const tab = s.openTabs.find(
    (t) => sessionKey(t.engine, t.sessionId, t.workspacePath) === key,
  );
  return (
    resolveSessionModel(tab, s.bySession[key], s.models[engine]) || null
  );
}

/** Effective reasoning effort for event-stamped rows: the session's activeEffort wins,
 * followed by the owning tab's per-tab override, then engine default. */
function stampedEffort(
  deps: EngineEventDeps,
  engine: string,
  key: string,
): string | null {
  const s = deps.get();
  const sessionActive = s.bySession[key]?.activeEffort;
  if (sessionActive) return sessionActive;
  const tab = s.openTabs.find(
    (t) => sessionKey(t.engine, t.sessionId, t.workspacePath) === key,
  );
  return (tab?.effort ?? s.efforts[engine]) || null;
}

function onModel(
  event: EngineEventPayload,
  key: string,
  deps: EngineEventDeps,
) {
  const model = typeof event.data === "string" ? event.data.trim() : "";
  if (!model) return;
  updatePendingStreamModel(key, model);
  deps.set((s) => {
    const cur = s.bySession[key];
    if (!cur) return {};
    let messages = cur.messages;
    if (messages.some((m) => m.role === "assistant" && m.live)) {
      messages = messages.map((m) =>
        m.role === "assistant" && m.live ? { ...m, model } : m,
      );
    }
    return {
      bySession: {
        ...s.bySession,
        [key]: {
          ...cur,
          activeModel: model,
          messages,
        },
      },
    };
  });
}

function onDelta(
  event: EngineEventPayload,
  key: string,
  deps: EngineEventDeps,
) {
  bufferStreamPart(
    key,
    "delta",
    event.data as string,
    stampedModel(deps, event.engine, key),
    stampedEffort(deps, event.engine, key),
  );
  scheduleDeltaFlush(deps.set);
}

function onThinking(
  event: EngineEventPayload,
  key: string,
  deps: EngineEventDeps,
) {
  bufferStreamPart(
    key,
    "thinking",
    event.data as string,
    stampedModel(deps, event.engine, key),
    stampedEffort(deps, event.engine, key),
  );
  scheduleDeltaFlush(deps.set);
}

function onMessage(
  event: EngineEventPayload,
  key: string,
  deps: EngineEventDeps,
) {
  const data = event.data as {
    role: string;
    text: string;
    path?: string | null;
    todos?: TodosPayload;
    args?: unknown;
    result?: unknown;
    patch?: boolean;
  };
  if (data.role === "tool" || data.role === "tool_result") {
    appendToolMessage(
      deps.set,
      key,
      data.text,
      stampedModel(deps, event.engine, key),
      data.path ?? null,
      data.todos ?? null,
      data.args,
      data.patch === true,
      data.result,
    );
    return;
  }
  if (data.role !== "assistant") return;
  // Full-snapshot assistant lines (kimi/codex non-delta) append as settled
  // messages; any live row above is finished growing.
  deps.set((s) => {
    const prev = s.bySession[key] ?? EMPTY_SESSION;
    const settled = settleLiveRows(prev.messages);
    const seq = settled.length ? settled[settled.length - 1].seq + 1 : 1;
    const durationMs = prev.turnStartedAt
      ? Math.max(0, Date.now() - prev.turnStartedAt)
      : null;
    return {
      bySession: {
        ...s.bySession,
        [key]: {
          ...prev,
          messages: [
            ...settled,
            {
              role: "assistant",
              text: data.text,
              ts: new Date().toISOString(),
              model: stampedModel(deps, event.engine, key),
              effort: stampedEffort(deps, event.engine, key),
              durationMs,
              seq,
            },
          ],
        },
      },
    };
  });
}

function onSession(
  event: EngineEventPayload,
  key: string,
  deps: EngineEventDeps,
) {
  const nativeId = event.data as string;
  // Resolve the workspace from the tab that owns this key — not from the
  // active tab. A first message sent on a background tab must not adopt the
  // foreground tab's workspace (the session would be orphaned there).
  const tab = deps
    .get()
    .openTabs.find(
      (t) => sessionKey(t.engine, t.sessionId, t.workspacePath) === key,
    );
  const workspacePath =
    tab?.workspacePath ?? deps.get().active?.workspacePath ?? "";
  const newKey = sessionKey(event.engine, nativeId, workspacePath);
  runRouting.set(event.runId, newKey);
  // Unflushed stream chunks sit under the pre-migration key; move them too.
  migratePendingStream(key, newKey);
  // Migrate pending key -> native key.
  deps.set((s) => {
    const prev = s.bySession[key];
    if (!prev) return {};
    const bySession = { ...s.bySession, [newKey]: prev };
    if (key !== newKey) delete bySession[key];
    const drafts = { ...s.drafts };
    if (key in drafts) {
      drafts[newKey] = drafts[key];
      delete drafts[key];
    }
    const streamingByKey = moveStreamingFlag(s.streamingByKey, key, newKey);
    const activeNext =
      s.active &&
      s.active.engine === event.engine &&
      s.active.sessionId === null &&
      s.active.workspacePath === workspacePath
        ? { ...s.active, sessionId: nativeId }
        : s.active;
    return { bySession, drafts, streamingByKey, active: activeNext };
  });
  // The pending tab owning this run adopts the native id. Stamp only the
  // first match: blanketing every pending tab of this engine+workspace
  // would turn a second "new chat" tab into a duplicate of this session
  // (identical React keys break the tab strip). Match by the resolved
  // workspace, so a background tab updates itself, not the foreground tab.
  deps.set((s) => {
    let stamped = false;
    const openTabs = dedupeTabs(
      s.openTabs.map((t) => {
        if (
          stamped ||
          t.engine !== event.engine ||
          t.sessionId !== null ||
          t.workspacePath !== workspacePath
        ) {
          return t;
        }
        stamped = true;
        return { ...t, sessionId: nativeId };
      }),
    );
    persistTabs(openTabs, s.active);
    return { openTabs };
  });
  // Sidebar row + tab title pick the new session up immediately instead of
  // waiting for the post-turn rescan.
  const firstUser = (deps.get().bySession[newKey]?.messages ?? []).find(
    (m) => m.role === "user",
  );
  deps.upsertSessionMeta(
    optimisticMeta(
      event.engine,
      nativeId,
      workspacePath,
      firstUser ? firstLineTitle(firstUser.text) : "",
    ),
  );
}

/** Usage reports per session for the turn in flight. Every report is one
 *  model response, so the ledger's request count is the sum of these — a
 *  number the engines actually produce, not a per-turn constant. */
const turnUsageReports = new Map<string, number>();

function onUsage(
  event: EngineEventPayload,
  key: string,
  deps: EngineEventDeps,
) {
  turnUsageReports.set(key, (turnUsageReports.get(key) ?? 0) + 1);
  patchSession(deps.set, key, { usage: event.data });
}

function onError(
  event: EngineEventPayload,
  key: string,
  deps: EngineEventDeps,
) {
  // Fold unflushed chunks into rows and settle them: the turn stops here,
  // and the scheduled flush must not write them in after the fact.
  const pending = drainPending(key);
  deps.set((s) => {
    const cur = s.bySession[key] ?? EMPTY_SESSION;
    let messages = settleLiveRows(
      pending
        ? applyStreamParts(
            cur.messages,
            pending.parts,
            pending.model ?? (deps.get().models[event.engine] || null),
            pending.effort ?? stampedEffort(deps, event.engine, key),
          )
        : cur.messages,
    );
    const durationMs = cur.turnStartedAt
      ? Math.max(0, Date.now() - cur.turnStartedAt)
      : null;
    if (durationMs != null) {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "assistant") {
          messages = [
            ...messages.slice(0, i),
            { ...messages[i], durationMs },
            ...messages.slice(i + 1),
          ];
          break;
        }
      }
    }
    return {
      bySession: {
        ...s.bySession,
        [key]: {
          ...cur,
          messages,
          error: event.data as string,
          streaming: false,
          turnStartedAt: null,
        },
      },
      streamingByKey: setStreamingFlag(s.streamingByKey, key, false),
    };
  });
  // The run is over: drop its routing entry so the map cannot grow forever.
  runRouting.delete(event.runId);
  deps.markUnseenIfBackground(key);
}

/** Patch the grant state of one card row, located by its message seq. */
export function patchGrantBySeq(
  set: (fn: (s: ChatStore) => Partial<ChatStore>) => void,
  key: string,
  seq: number,
  patch: (grant: NonNullable<Message["grant"]>) => NonNullable<Message["grant"]>,
) {
  set((s) => {
    const cur = s.bySession[key];
    if (!cur) return {};
    let changed = false;
    const messages = cur.messages.map((m) => {
      if (m.seq !== seq || m.role !== "grant" || !m.grant) return m;
      changed = true;
      return { ...m, grant: patch(m.grant) };
    });
    if (!changed) return {};
    return { bySession: { ...s.bySession, [key]: { ...cur, messages } } };
  });
}

/** A permission denial arrives mid-turn (tool_result) and again in the
 * final result's permission_denials; one card per denied path. The card is
 * the actionable surface: grant → next launch gets --add-dir. */
function onPermissionDenied(
  event: EngineEventPayload,
  key: string,
  deps: EngineEventDeps,
) {
  const data = event.data as {
    tool?: string | null;
    path?: string | null;
    message?: string;
  };
  const path = data.path?.trim() || null;
  const message = (data.message ?? "").trim();
  // Fold unflushed chunks first so the card lands after the streamed text.
  const pending = drainPending(key);
  let rowSeq = -1;
  deps.set((s) => {
    const cur = s.bySession[key] ?? EMPTY_SESSION;
    const base = pending
      ? applyStreamParts(
          cur.messages,
          pending.parts,
          pending.model ?? (deps.get().models[event.engine] || null),
        )
      : cur.messages;
    const messages = settleLiveRows(base);
    const dup = messages.some(
      (m) =>
        m.role === "grant" &&
        (path ? m.path === path : m.text === message) &&
        m.grant?.status !== "declined",
    );
    if (dup) return {};
    const seq = messages.length ? messages[messages.length - 1].seq + 1 : 1;
    rowSeq = seq;
    return {
      bySession: {
        ...s.bySession,
        [key]: {
          ...cur,
          messages: [
            ...messages,
            {
              role: "grant",
              text: message,
              path,
              ts: new Date().toISOString(),
              seq,
              grant: { status: "pending" as const },
            },
          ],
        },
      },
    };
  });
  // Preview the directory a grant would cover; failure is non-fatal — the
  // backend re-resolves inside grant_root.
  if (path && rowSeq > 0) {
    void ipc
      .grantScope(path)
      .then((dir) =>
        patchGrantBySeq(deps.set, key, rowSeq, (grant) => ({ ...grant, dir })),
      )
      .catch(() => {});
  }
}

function onWarn(event: EngineEventPayload, key: string, deps: EngineEventDeps) {
  // Non-terminal notice (e.g. an upstream 429 the CLI is retrying): show the
  // banner, but the turn is still alive — streaming state, unflushed chunks,
  // and run routing all stay untouched. Cleared by onDone when the turn
  // recovers, overwritten by onError if it ends up failing.
  patchSession(deps.set, key, { error: event.data as string });
}

function onDone(event: EngineEventPayload, key: string, deps: EngineEventDeps) {
  const prev = deps.get().bySession[key] ?? EMPTY_SESSION;
  const data = event.data as { usage: unknown };
  const finalUsage = mergeUsage(data.usage, prev.usage);
  // Fold the turn's last unflushed chunks (the final sink batch can arrive
  // in the same frame as done), then settle every live row: the streamed
  // text the user watched arrive *is* the final message.
  const pending = drainPending(key);
  deps.set((s) => {
    const cur = s.bySession[key] ?? EMPTY_SESSION;
    let messages = pending
      ? applyStreamParts(
          cur.messages,
          pending.parts,
          pending.model ?? (deps.get().models[event.engine] || null),
          pending.effort ?? stampedEffort(deps, event.engine, key),
        )
      : cur.messages;
    messages = settleLiveRows(messages);
    const turnStart = cur.turnStartedAt ?? prev.turnStartedAt;
    const durationMs = turnStart ? Math.max(0, Date.now() - turnStart) : null;
    const model = stampedModel(deps, event.engine, key);
    const effort = stampedEffort(deps, event.engine, key);
    // Stamp usage, durationMs, effort, and model onto the turn's last assistant message.
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") {
        messages = [
          ...messages.slice(0, i),
          {
            ...messages[i],
            ...(finalUsage ? { usage: finalUsage } : {}),
            ...(durationMs != null ? { durationMs } : {}),
            ...(effort ? { effort } : {}),
            ...(model ? { model } : {}),
          },
          ...messages.slice(i + 1),
        ];
        break;
      }
    }
    return {
      bySession: {
        ...s.bySession,
        [key]: {
          ...cur,
          messages,
          error: null,
          streaming: false,
          turnStartedAt: null,
          usage: finalUsage,
          interrupted: false,
        },
      },
      streamingByKey: setStreamingFlag(s.streamingByKey, key, false),
    };
  });
  // The run is over: drop its routing entry so the map cannot grow forever.
  runRouting.delete(event.runId);
  // Ledger the turn's tokens now that it is settled: the same report that
  // stamps the row above, so the usage page counts real engine numbers. The
  // feature's own switch gates it (localStorage-backed, see usage-tracking.ts).
  recordTurnUsage(deps, event, key, finalUsage);
  // Native file changed; refresh list cache in background.
  ipc.rescanSessions().catch(() => {});
  deps.markUnseenIfBackground(key);
  // An interrupted turn settles here too: keep the queue parked — the user
  // stopped the session, the next message is theirs to send.
  if (!prev.interrupted) {
    deps.drainQueue(key);
    // If this turn was a /compact command, refresh latest token usage from session history
    // once the engine settles the session file on disk.
    const lastUser = [...prev.messages].reverse().find((m) => m.role === "user");
    if (lastUser?.text.trim().startsWith("/compact")) {
      setTimeout(() => {
        deps.refreshSessionUsage?.(key)?.catch(() => {});
      }, 400);
    }
  }
}

/** Ledger one settled turn. Skipped when the feature is off or the engine
 *  reported nothing (an interrupted turn before its first report). */
function recordTurnUsage(
  deps: EngineEventDeps,
  event: EngineEventPayload,
  key: string,
  usage: unknown,
) {
  if (!usageTrackingEnabled()) return;
  const parsed = parseUsage(usage);
  const reports = turnUsageReports.get(key) ?? 0;
  turnUsageReports.delete(key);
  if (!parsed) return;
  const state = deps.get();
  const tab = state.openTabs.find(
    (t) => sessionKey(t.engine, t.sessionId, t.workspacePath) === key,
  );
  void ipc
    .usageRecord({
      ts: Date.now(),
      engine: event.engine,
      model: stampedModel(deps, event.engine, key),
      sessionId: event.sessionId ?? tab?.sessionId ?? null,
      workspacePath: tab?.workspacePath ?? state.active?.workspacePath ?? null,
      input: parsed.input,
      output: parsed.output,
      cacheRead: parsed.cacheRead,
      cacheWrite: parsed.cacheWrite,
      // At least 1: a turn with usage but no counted report still spent one.
      reports: Math.max(1, reports),
      durationMs: null,
    })
    .catch(() => {});
}

/** Resolve an event's session key (run routing, then session-id match) and
 * dispatch to the per-kind handler. */
export function handleEngineEvents(
  events: EngineEventPayload[],
  deps: EngineEventDeps,
) {
  for (const event of events) {
    const state = deps.get();
    let key = runRouting.get(event.runId);
    if (!key && event.sessionId) {
      key = sessionKey(event.engine, event.sessionId, "");
      // sessionId-only key lacks workspace; find active match
      if (!(key in state.bySession)) {
        const match = Object.keys(state.bySession).find(
          (k) => k === key || k.endsWith(`/${event.sessionId}`),
        );
        if (match) key = match;
      }
    }
    if (!key) continue;

    switch (event.kind) {
      case "delta":
        onDelta(event, key, deps);
        break;
      case "thinking":
        onThinking(event, key, deps);
        break;
      case "message":
        onMessage(event, key, deps);
        break;
      case "session":
        onSession(event, key, deps);
        break;
      case "usage":
        onUsage(event, key, deps);
        break;
      case "error":
        onError(event, key, deps);
        break;
      case "warn":
        onWarn(event, key, deps);
        break;
      case "permission_denied":
        onPermissionDenied(event, key, deps);
        break;
      case "done":
        onDone(event, key, deps);
        break;
      case "model":
        onModel(event, key, deps);
        break;
    }
  }
}
