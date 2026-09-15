import { ipc, type Message, type SessionMeta, type TodosPayload } from "@/lib/ipc";
import type { EngineEventPayload } from "@/lib/events";
import { dedupeTabs, persistTabs, sessionKey } from "./persistence";
import { migrateSessionContributions } from "./session-contributions";
import {
  EMPTY_SESSION,
  appendToolMessage,
  applyStreamParts,
  bufferStreamPart,
  drainPending,
  migratePendingStream,
  moveStreamingFlag,
  patchSession,
  resolveSessionEffort,
  resolveSessionModel,
  routeRun,
  runRouting,
  scheduleDeltaFlush,
  setStreamingFlag,
  settleLiveRows,
  touchRun,
  untrackRun,
  updatePendingStreamModel,
} from "./stream";
import type { ChatStore } from "../store";
import { mergeUsage, parseUsage, type ParsedUsage } from "../usage";
import { usageTrackingEnabled } from "@/features/settings/usage-tracking";
import type {
  RegisteredInternalMessageCapture,
} from "@/features/plugins/runtime/hooks";
import {
  dispatchAfterTurn,
  dispatchInternalMessage,
  dispatchRuntimeEvent,
  dispatchSessionCreated,
} from "@/features/plugins/runtime/hooks";
import { normalizeEngineEvent, type EngineTerminalFact } from "../normalized-runtime-events";
import type { InternalMessageCapture, WorkspaceMetadata } from "@ccgui/plugin-sdk";
interface RunLifecycle {
  turnId: string;
  engine: string;
  sessionId: string | null;
  workspace: WorkspaceMetadata;
  captures: RegisteredInternalMessageCapture[];
  acceptedFrames?: string[];
}

interface CaptureBuffer {
  lifecycle: RunLifecycle;
  text: string;
}

const runLifecycles = new Map<string, RunLifecycle>();
const captureBuffers = new Map<string, CaptureBuffer>();
/** Placeholder id -> lifecycle awaiting its real run id. A fast engine can
 * emit session/delta/done before the send resolves, so the lifecycle is
 * registered up front and rekeyed (or bound by the event) once the id exists. */
const pendingRuns = new Map<string, RunLifecycle>();
/** Run ids already bound to a lifecycle (bounded, oldest first). Keeps a
 * trailing event from a settled run off another run's pending lifecycle. */
const knownRunIds = new Set<string>();
const KNOWN_RUN_ID_LIMIT = 512;
/** Events that outran an ambiguous set of same-engine pending sends. The
 * SendResult later identifies the owner and replays that run in order. */
const bufferedEarlyEvents = new Map<string, EngineEventPayload[]>();
const BUFFERED_EARLY_RUN_LIMIT = 64;
const BUFFERED_EARLY_EVENT_LIMIT = 256;

function bufferEarlyEvent(event: EngineEventPayload): void {
  const buffered = bufferedEarlyEvents.get(event.runId) ?? [];
  if (buffered.length < BUFFERED_EARLY_EVENT_LIMIT) buffered.push(event);
  bufferedEarlyEvents.delete(event.runId);
  bufferedEarlyEvents.set(event.runId, buffered);
  if (bufferedEarlyEvents.size > BUFFERED_EARLY_RUN_LIMIT) {
    const oldest = bufferedEarlyEvents.keys().next().value;
    if (oldest !== undefined) bufferedEarlyEvents.delete(oldest);
  }
}

function rememberRunId(runId: string): void {
  knownRunIds.add(runId);
  if (knownRunIds.size > KNOWN_RUN_ID_LIMIT) {
    const oldest = knownRunIds.values().next().value;
    if (oldest !== undefined) knownRunIds.delete(oldest);
  }
}

/** A frame identity the host failed to store would silently unhide that frame
 * in reloaded history, so a failed record is retried. Attempts are bounded: a
 * permanently failing backend must not spin. */
const FRAME_RECORD_RETRY_MS = 500;
const FRAME_RECORD_MAX_ATTEMPTS = 5;

function recordAcceptedFrame(
  engine: string,
  sessionId: string,
  frame: string,
  attempt: number,
): void {
  void ipc.recordAcceptedInternalFrame(engine, sessionId, frame).catch(() => {
    if (attempt >= FRAME_RECORD_MAX_ATTEMPTS) return;
    setTimeout(
      () => recordAcceptedFrame(engine, sessionId, frame, attempt + 1),
      FRAME_RECORD_RETRY_MS,
    );
  });
}

function persistAcceptedFrames(lifecycle: RunLifecycle): void {
  const frames = lifecycle.acceptedFrames;
  const sessionId = lifecycle.sessionId;
  if (!sessionId || !frames || frames.length === 0) return;
  for (const frame of frames.splice(0)) {
    recordAcceptedFrame(lifecycle.engine, sessionId, frame, 1);
  }
}

/** Register a run's lifecycle before its real run id exists. */
export function registerPendingRunLifecycle(
  placeholderId: string,
  lifecycle: RunLifecycle,
): void {
  lifecycle.acceptedFrames = [];
  runLifecycles.set(placeholderId, lifecycle);
  captureBuffers.set(placeholderId, { lifecycle, text: "" });
  pendingRuns.set(placeholderId, lifecycle);
}

/** Move a pre-registered lifecycle onto the run id the send returned and adopt
 * the native session id. Safe to call after an early event already bound it, or
 * when it is already gone. */
export function bindRunLifecycle(
  placeholderId: string,
  runId: string,
  sessionId?: string | null,
): void {
  const pending = pendingRuns.get(placeholderId);
  if (!pending) {
    // An early event already bound it (or the lifecycle is gone). Still record
    // the native session so later internal-message events carry it.
    const bound = runLifecycles.get(runId);
    if (bound && sessionId) {
      bound.sessionId = sessionId;
      persistAcceptedFrames(bound);
    }
    pendingRuns.delete(placeholderId);
    rememberRunId(runId);
    return;
  }
  if (sessionId) {
    pending.sessionId = sessionId;
    persistAcceptedFrames(pending);
  }
  if (placeholderId === runId) {
    pendingRuns.delete(placeholderId);
    rememberRunId(runId);
    return;
  }
  const buffer = captureBuffers.get(placeholderId);
  pendingRuns.delete(placeholderId);
  runLifecycles.delete(placeholderId);
  captureBuffers.delete(placeholderId);
  runLifecycles.set(runId, pending);
  if (buffer) captureBuffers.set(runId, buffer);
  rememberRunId(runId);
}

/** An engine event may outrun the send result. Bind it to the one lifecycle
 * pre-registered for the same engine (and, when both sides know a native
 * session, the same session); ambiguous or absent candidates stay unbound and
 * are rekeyed by the store when the send resolves. */
function bindUnboundRun(event: EngineEventPayload): boolean {
  if (runLifecycles.has(event.runId) || knownRunIds.has(event.runId)) return false;
  let match: string | undefined;
  for (const [placeholder, lifecycle] of pendingRuns) {
    if (lifecycle.engine !== event.engine) continue;
    if (
      event.sessionId !== null &&
      lifecycle.sessionId !== null &&
      lifecycle.sessionId !== event.sessionId
    ) {
      continue;
    }
    if (match !== undefined) return false;
    match = placeholder;
  }
  if (match === undefined) return false;
  bindRunLifecycle(match, event.runId);
  return true;
}
/** Replay events buffered while multiple pending sends made ownership
 * ambiguous. Call only after binding and routing the real run id. */
export function replayBufferedEngineEvents(runId: string, deps: EngineEventDeps): void {
  const events = bufferedEarlyEvents.get(runId);
  if (!events) return;
  bufferedEarlyEvents.delete(runId);
  handleEngineEvents(events, deps);
}

export function cancelRunLifecycle(runId: string): void {
  const lifecycle = runLifecycles.get(runId);
  if (!lifecycle) return;
  dispatchAfterTurn({
    runId,
    turnId: lifecycle.turnId,
    engine: lifecycle.engine,
    sessionId: lifecycle.sessionId,
    workspace: lifecycle.workspace,
    occurredAt: new Date().toISOString(),
    status: "cancelled",
  });
  unregisterRunLifecycle(runId);
}
export function unregisterRunLifecycle(runId: string): void {
  // A turn can settle before its send result resolved the native session id.
  // Frames accepted meanwhile are parked on the lifecycle, so flush them here:
  // after this the lifecycle is gone and a later bind finds nothing, leaving
  // the frame hidden live but visible again on reload. A run that never
  // resolved a session id has no scope to record under and cannot be saved.
  const lifecycle = runLifecycles.get(runId);
  if (lifecycle) persistAcceptedFrames(lifecycle);
  runLifecycles.delete(runId);
  captureBuffers.delete(runId);
  pendingRuns.delete(runId);
  bufferedEarlyEvents.delete(runId);
}

function frameOpen(nonce: string): string {
  return `<CCGUI_INTERNAL_${nonce}>`;
}

function frameClose(nonce: string): string {
  return `</CCGUI_INTERNAL_${nonce}>`;
}
function validInternalNonce(nonce: string | undefined): nonce is string {
  return (
    nonce !== undefined &&
    nonce.length >= 1 &&
    nonce.length <= 128 &&
    /^[A-Za-z0-9_-]+$/.test(nonce)
  );
}

/**
 * A frame is consumed (hidden from the transcript and routed to its plugin)
 * only when it parses as complete JSON, fits the byte budget, and the owning
 * plugin's synchronous validator explicitly accepts the payload. Rejected,
 * oversized, and incomplete frames stay visible — the host must not hide
 * output the plugin cannot vouch for.
 */
function acceptsCapture(
  capture: InternalMessageCapture,
  payload: unknown,
  bytes: number,
): boolean {
  if (payload === undefined || bytes > capture.maxBytes) return false;
  if (!capture.validate) return true;
  try {
    return capture.validate(payload) === true;
  } catch {
    return false;
  }
}

function processCaptureBuffer(runId: string, flush: boolean): string {
  const state = captureBuffers.get(runId);
  if (!state) return "";
  // No capture registered for this run (the default when no plugin asked for
  // one): nothing can ever be a hidden frame, so the buffered text is visible
  // as-is. Returning it here — and clearing it — keeps deltas flowing; the
  // frame scanner below would otherwise hold the text forever.
  if (state.lifecycle.captures.length === 0) {
    const visible = state.text;
    state.text = "";
    return visible;
  }
  let visible = "";
  let rest = state.text;
  while (rest) {
    let selected:
      | { capture: RegisteredInternalMessageCapture; index: number; open: string; close: string }
      | undefined;
    for (const capture of state.lifecycle.captures) {
      const nonce = capture.capture.nonce;
      if (!validInternalNonce(nonce)) continue;
      const open = frameOpen(nonce);
      const index = rest.indexOf(open);
      if (index >= 0 && (!selected || index < selected.index)) {
        selected = { capture, index, open, close: frameClose(nonce) };
      }
    }
    if (!selected) {
      if (flush) {
        visible += rest;
        rest = "";
      } else {
        // Keep the longest suffix that could still become one of this run's
        // complete opening tags. Deltas may split anywhere, including inside
        // the nonce; retaining only the fixed marker leaks that frame before
        // the next chunk can complete it.
        let split = rest.length;
        for (const registered of state.lifecycle.captures) {
          const nonce = registered.capture.nonce;
          if (!validInternalNonce(nonce)) continue;
          const open = frameOpen(nonce);
          const maxPrefix = Math.min(rest.length, open.length - 1);
          for (let size = maxPrefix; size > 0; size--) {
            if (open.startsWith(rest.slice(-size))) {
              split = Math.min(split, rest.length - size);
              break;
            }
          }
        }
        visible += rest.slice(0, split);
        rest = rest.slice(split);
      }
      break;
    }
    visible += rest.slice(0, selected.index);
    const contentStart = selected.index + selected.open.length;
    const closeIndex = rest.indexOf(selected.close, contentStart);
    if (closeIndex < 0) {
      rest = rest.slice(selected.index);
      // A UTF-16 code unit never encodes to fewer than one UTF-8 byte, so more
      // pending units than the budget means more pending bytes too. Re-encoding
      // the whole pending payload on every delta would make this quadratic over
      // a turn; this bound is O(1) and still releases before growth is
      // unbounded.
      const pendingUnits = rest.length - selected.open.length;
      // Flushing, or a payload already past the capture's own budget: this
      // frame can never be accepted, so release it instead of holding the rest
      // of the turn behind one unterminated tag.
      if (flush || pendingUnits > selected.capture.capture.maxBytes) {
        visible += rest;
        rest = "";
      }
      break;
    }
    const payloadText = rest.slice(contentStart, closeIndex);
    const bytes = new TextEncoder().encode(payloadText).byteLength;
    let payload: unknown;
    try {
      payload = JSON.parse(payloadText);
    } catch {
      payload = undefined;
    }
    const frameEnd = closeIndex + selected.close.length;
    const frame = rest.slice(selected.index, frameEnd);
    if (!acceptsCapture(selected.capture.capture, payload, bytes)) {
      visible += frame;
    } else {
      const lifecycle = state.lifecycle;
      (lifecycle.acceptedFrames ??= []).push(frame);
      persistAcceptedFrames(lifecycle);
      dispatchInternalMessage(selected.capture.pluginId, {
        runId,
        turnId: lifecycle.turnId,
        engine: lifecycle.engine,
        sessionId: lifecycle.sessionId,
        workspace: lifecycle.workspace,
        occurredAt: new Date().toISOString(),
        channel: selected.capture.capture.channel,
        ...(selected.capture.capture.nonce ? { nonce: selected.capture.capture.nonce } : {}),
        payload,
      });
    }
    rest = rest.slice(frameEnd);
  }
  state.text = rest;
  return visible;
}

export function filterInternalFrameDelta(runId: string, text: string): string {
  const state = captureBuffers.get(runId);
  if (!state) return text;
  state.text += text;
  return processCaptureBuffer(runId, false);
}

export function flushInternalFrameDelta(runId: string): string {
  return processCaptureBuffer(runId, true);
}

function dispatchNormalized(event: EngineEventPayload, terminal?: EngineTerminalFact): void {
  const lifecycle = runLifecycles.get(event.runId);
  if (!lifecycle) return;
  const normalized = normalizeEngineEvent(event, {
    workspaceId: lifecycle.workspace.id,
    workspacePath: lifecycle.workspace.path,
    occurredAt: new Date().toISOString(),
    ...(terminal ? { terminal } : {}),
  });
  if (normalized) dispatchRuntimeEvent(normalized);
}

function finishLifecycle(
  event: EngineEventPayload,
  status: "completed" | "cancelled" | "failed",
  error?: string,
): void {
  const lifecycle = runLifecycles.get(event.runId);
  if (!lifecycle) return;
  dispatchAfterTurn({
    runId: event.runId,
    turnId: lifecycle.turnId,
    engine: event.engine,
    sessionId: event.sessionId ?? lifecycle.sessionId,
    workspace: lifecycle.workspace,
    occurredAt: new Date().toISOString(),
    status,
    ...(error === undefined ? {} : { error }),
  });
  unregisterRunLifecycle(event.runId);
}

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

/** Effective reasoning effort for event-stamped rows. Native-session state
 * wins; a tab override is only valid before that session receives its id. */
function stampedEffort(
  deps: EngineEventDeps,
  engine: string,
  key: string,
): string | null {
  const s = deps.get();
  const tab = s.openTabs.find(
    (t) => sessionKey(t.engine, t.sessionId, t.workspacePath) === key,
  );
  return resolveSessionEffort(tab, s.bySession[key], s.efforts[engine]) || null;
}

function onModel(
  event: EngineEventPayload,
  key: string,
  deps: EngineEventDeps,
) {
  const reported = typeof event.data === "string" ? event.data.trim() : "";
  if (!reported) return;
  // The engine reports the bare model name; our own record spells it
  // "provider/model" (see ipc.rememberSessionModel). Same model, more
  // context — keep the qualified one instead of dropping the provider.
  const current = deps.get().bySession[key]?.activeModel ?? "";
  const model =
    current === reported || current.endsWith(`/${reported}`) ? current : reported;
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
  const text = filterInternalFrameDelta(event.runId, event.data as string);
  if (!text) return;
  bufferStreamPart(
    key,
    "delta",
    text,
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
  // Snapshots are a stream boundary: feed them through the same run-scoped
  // capture parser as deltas, then flush any unmatched/incomplete text so it
  // remains visible instead of leaking into a later event.
  const text =
    filterInternalFrameDelta(event.runId, data.text) +
    flushInternalFrameDelta(event.runId);
  // Full-snapshot assistant lines (kimi/codex non-delta) append as settled
  // messages; any live row above is finished growing even when the snapshot
  // contained only an accepted internal frame.
  deps.set((s) => {
    const prev = s.bySession[key] ?? EMPTY_SESSION;
    const settled = settleLiveRows(prev.messages);
    if (!text) {
      return {
        bySession: {
          ...s.bySession,
          [key]: { ...prev, messages: settled },
        },
      };
    }
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
              text,
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

/** Model a local send resolved for a session key, held until the run reports
 *  the native session id (`session` event) so the two can be remembered
 *  together — the engine transcript only carries the bare model name, and the
 *  new session's id is not known before that event. Only local sends fill
 *  this: an observer must never write its own (bare) reading of a run. */
const pendingSessionModels = new Map<string, string>();
/** Same hand-off for the reasoning level: it is chosen before the first send
 *  of a new session and can only be filed under the id the `session` event
 *  carries. */
const pendingSessionEfforts = new Map<string, string>();

export function rememberModelForRun(
  key: string,
  model: string | null | undefined,
) {
  if (model) pendingSessionModels.set(key, model);
}

export function rememberEffortForRun(
  key: string,
  effort: string | null | undefined,
) {
  if (effort) pendingSessionEfforts.set(key, effort);
}

function onSession(
  event: EngineEventPayload,
  key: string,
  deps: EngineEventDeps,
) {
  const nativeId = event.data as string;
  const lifecycle = runLifecycles.get(event.runId);
  if (lifecycle) {
    lifecycle.sessionId = nativeId;
    persistAcceptedFrames(lifecycle);
  }
  const sentModel = pendingSessionModels.get(key);
  if (sentModel) {
    pendingSessionModels.delete(key);
    void ipc
      .rememberSessionModel(event.engine, nativeId, sentModel)
      .catch(() => {});
  }
  const sentEffort = pendingSessionEfforts.get(key);
  if (sentEffort) {
    pendingSessionEfforts.delete(key);
    void ipc
      .rememberSessionEffort(event.engine, nativeId, sentEffort)
      .catch(() => {});
  }
  // Resolve the workspace from the tab that owns this key — not from the
  // active tab. A first message sent on a background tab must not adopt the
  // foreground tab's workspace (the session would be orphaned there).
  const tab = deps
    .get()
    .openTabs.find(
      (t) => sessionKey(t.engine, t.sessionId, t.workspacePath) === key,
    );
  const workspacePath =
    lifecycle?.workspace.path ?? tab?.workspacePath ?? deps.get().active?.workspacePath ?? "";
  const newKey = sessionKey(event.engine, nativeId, workspacePath);
  // The event can resolve straight to the native key when it beat the send
  // response (the run had no routing entry yet). The turn rows and streaming
  // flag still sit under the pending key then; migrate from there instead of
  // orphaning them on a key nothing renders.
  const pendingKey = sessionKey(event.engine, null, workspacePath);
  const fromKey = deps.get().bySession[key]
    ? key
    : pendingKey !== key && deps.get().bySession[pendingKey]
      ? pendingKey
      : key;
  settleOrphanedRuns(deps.set, routeRun(event.runId, newKey));
  // Unflushed stream chunks sit under the pre-migration key; move them too.
  migratePendingStream(fromKey, newKey);
  // A delta-only engine reports no native id from the send, so a remembered
  // session contribution still sits under the pending scope. Rekey it onto the
  // native id exactly like the session state (the workspace resolved above is
  // the one sendPrompt remembered under), so later turns re-inject it.
  deps.set((s) => {
    const next = migrateSessionContributions(
      s.sessionContributions,
      event.engine,
      workspacePath,
      nativeId,
    );
    return next ? { sessionContributions: next } : {};
  });
  // Migrate pending key -> native key.
  deps.set((s) => {
    const prev = s.bySession[fromKey];
    if (!prev) return {};
    const bySession = { ...s.bySession, [newKey]: prev };
    if (fromKey !== newKey) delete bySession[fromKey];
    const drafts = { ...s.drafts };
    if (fromKey in drafts) {
      drafts[newKey] = drafts[fromKey];
      delete drafts[fromKey];
    }
    const streamingByKey = moveStreamingFlag(s.streamingByKey, fromKey, newKey);
    const activeNext =
      s.active &&
      s.active.engine === event.engine &&
      s.active.sessionId === null &&
      s.active.workspacePath === workspacePath
        ? { ...s.active, sessionId: nativeId, effort: undefined }
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
        return { ...t, sessionId: nativeId, effort: undefined };
      }),
    );
    persistTabs(openTabs, s.active);
    return { openTabs };
  });
  const createdKey = sessionKey(event.engine, nativeId, workspacePath);
  if (!deps.get().createdSessionKeys[createdKey]) {
    deps.set((s) => ({
      createdSessionKeys: { ...s.createdSessionKeys, [createdKey]: true },
    }));
    const workspace = lifecycle?.workspace ?? {
      id: workspacePath,
      path: workspacePath,
    };
    dispatchSessionCreated({
      engine: event.engine,
      sessionId: nativeId,
      workspace,
      occurredAt: new Date().toISOString(),
    });
  }
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

/** Runs whose turn already wrote ledger rows report by report. Every report
 *  is one model response, so each lands in the ledger the moment it arrives —
 *  a codex turn that chats for an hour has to show up while it runs, not when
 *  it ends — and `done` must not write the same tokens again. */
const liveLedgerRuns = new Set<string>();

/** Running token totals for the reply in flight, keyed by run. `usage` keeps
 *  the newest report (the context meter needs occupancy, not a sum), while
 *  the tail indicator and the settled row show this total: what the reply has
 *  spent so far. Claude reports nothing until the end, so it never appears. */
const turnUsageTotals = new Map<string, ParsedUsage>();
/** Drop a run's usage bookkeeping (settled, interrupted, or swept). */
export function dropRunUsage(runId: string) {
  turnUsageTotals.delete(runId);
  liveLedgerRuns.delete(runId);
}

/** Drop every trace of runs the orphan sweep reaped: their usage maps here
 * and the session's stuck streaming state in the store — a dead run's
 * done/error never arrives to clear them. */
export function settleOrphanedRuns(
  set: (fn: (s: ChatStore) => Partial<ChatStore>) => void,
  orphaned: Array<[string, string]>,
) {
  if (orphaned.length === 0) return;
  for (const [runId] of orphaned) dropRunUsage(runId);
  set((s) => {
    let streamingByKey = s.streamingByKey;
    let bySession = s.bySession;
    for (const [, key] of orphaned) {
      streamingByKey = setStreamingFlag(streamingByKey, key, false);
      const cur = bySession[key];
      if (cur?.streaming) {
        if (bySession === s.bySession) bySession = { ...s.bySession };
        bySession[key] = { ...cur, streaming: false, turnStartedAt: null };
      }
    }
    return { bySession, streamingByKey };
  });
}

function onUsage(
  event: EngineEventPayload,
  key: string,
  deps: EngineEventDeps,
) {
  const parsed = parseUsage(event.data);
  const totals = parsed ? addTurnUsage(event.runId, parsed) : null;
  patchSession(deps.set, key, {
    usage: event.data,
    ...(totals ? { turnUsage: usageSnapshot(totals) } : {}),
  });
  if (parsed) recordUsageReport(deps, event, key, parsed);
}

/** Fold one report into its run's running total. */
function addTurnUsage(runId: string, parsed: ParsedUsage): ParsedUsage {
  const prev = turnUsageTotals.get(runId);
  const totals: ParsedUsage = {
    input: (prev?.input ?? 0) + parsed.input,
    output: (prev?.output ?? 0) + parsed.output,
    cacheRead: (prev?.cacheRead ?? 0) + parsed.cacheRead,
    cacheWrite: (prev?.cacheWrite ?? 0) + parsed.cacheWrite,
    total: 0,
    // A later report may omit the window; the last one that reported it wins.
    contextWindow: parsed.contextWindow ?? prev?.contextWindow,
  };
  totals.total = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
  turnUsageTotals.set(runId, totals);
  return totals;
}

/** Engine-shaped snapshot of a running total: parseUsage reads it back, and
 *  every consumer downstream (strip, row, breakdown) stays engine-agnostic. */
function usageSnapshot(totals: ParsedUsage): Record<string, number> {
  return {
    input_tokens: totals.input,
    output_tokens: totals.output,
    cache_read_input_tokens: totals.cacheRead,
    cache_creation_input_tokens: totals.cacheWrite,
    ...(totals.contextWindow ? { model_context_window: totals.contextWindow } : {}),
  };
}

/** Ledger one engine report (one request) as it arrives. */
function recordUsageReport(
  deps: EngineEventDeps,
  event: EngineEventPayload,
  key: string,
  parsed: ParsedUsage,
) {
  if (!usageTrackingEnabled()) return;
  liveLedgerRuns.add(event.runId);
  writeUsageRow(deps, event, key, parsed, 1);
}

/** Shared writer: one ledger row for the run's model and session. */
function writeUsageRow(
  deps: EngineEventDeps,
  event: EngineEventPayload,
  key: string,
  parsed: ParsedUsage,
  reports: number,
) {
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
      reports,
      durationMs: null,
    })
    .catch(() => {});
}

function onError(
  event: EngineEventPayload,
  key: string,
  deps: EngineEventDeps,
) {
  const buffered = flushInternalFrameDelta(event.runId);
  if (buffered) {
    bufferStreamPart(
      key,
      "delta",
      buffered,
      stampedModel(deps, event.engine, key),
      stampedEffort(deps, event.engine, key),
    );
  }
  // Fold unflushed chunks into rows and settle them: the turn stops here,
  // and the scheduled flush must not write them in after the fact.
  const prev = deps.get().bySession[key] ?? EMPTY_SESSION;
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
          turnUsage: null,
        },
      },
      streamingByKey: setStreamingFlag(s.streamingByKey, key, false),
    };
  });
  // The run is over: drop its routing entry and usage bookkeeping so the
  // maps cannot grow forever.
  runRouting.delete(event.runId);
  untrackRun(event.runId);
  dropRunUsage(event.runId);
  deps.markUnseenIfBackground(key);
  dispatchNormalized(event);
  finishLifecycle(event, "failed", typeof event.data === "string" ? event.data : undefined);
  // An error settles the turn exactly like done does — the messages typed
  // behind it are the user's next step, and parking them here left the queue
  // stuck until it was sent or cleared by hand. A stop is still the user's
  // own call: that queue stays parked.
  if (!prev.interrupted) deps.drainQueue(key);
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
  const buffered = flushInternalFrameDelta(event.runId);
  if (buffered) {
    bufferStreamPart(
      key,
      "delta",
      buffered,
      stampedModel(deps, event.engine, key),
      stampedEffort(deps, event.engine, key),
    );
  }
  // Occupancy for the context meter: the newest single report (claude's one
  // payload already carries the turn's totals).
  const settledUsage = mergeUsage(data.usage, prev.usage);
  // The row tells the reader what the reply cost: every report of this run
  // summed, which for a multi-request reply is more than its last request.
  const turnTotals = turnUsageTotals.get(event.runId);
  turnUsageTotals.delete(event.runId);
  const finalUsage = turnTotals
    ? mergeUsage(usageSnapshot(turnTotals), settledUsage)
    : settledUsage;
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
          usage: settledUsage,
          turnUsage: null,
          interrupted: false,
        },
      },
      streamingByKey: setStreamingFlag(s.streamingByKey, key, false),
    };
  });
  // The run is over: drop its routing entry so the map cannot grow forever.
  runRouting.delete(event.runId);
  const cancelled = prev.interrupted;
  dispatchNormalized(event, { status: cancelled ? "cancelled" : "completed" });
  finishLifecycle(event, cancelled ? "cancelled" : "completed");
  untrackRun(event.runId);
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

/** Ledger the turn's own report when it never reported live (claude sends one
 *  usage payload, the turn's totals, on its result line). Turns that streamed
 *  reports already have their rows. */
function recordTurnUsage(
  deps: EngineEventDeps,
  event: EngineEventPayload,
  key: string,
  usage: unknown,
) {
  if (!usageTrackingEnabled()) return;
  if (liveLedgerRuns.delete(event.runId)) return;
  const parsed = parseUsage(usage);
  if (!parsed) return;
  writeUsageRow(deps, event, key, parsed, 1);
}

/** Mark a session running off an event of a turn this client never sent: the
 *  phone watching the desktop's run, or the desktop watching the phone's.
 *  Routes the run first so Stop and the orphan sweep reach it, then lifts the
 *  two flags the composer / sidebar / tab dots read. */
function adoptObservedRun(
  event: EngineEventPayload,
  key: string,
  deps: EngineEventDeps,
) {
  if (!runRouting.has(event.runId)) {
    settleOrphanedRuns(deps.set, routeRun(event.runId, key));
  }
  const cur = deps.get().bySession[key];
  if (!cur?.streaming) {
    patchSession(deps.set, key, {
      streaming: true,
      turnStartedAt: cur?.turnStartedAt ?? Date.now(),
    });
  }
  if (!deps.get().streamingByKey[key]) {
    deps.set((s) => ({
      streamingByKey: setStreamingFlag(s.streamingByKey, key, true),
    }));
  }
}

/** Resolve an event's session key (run routing, then session-id match) and
 * dispatch to the per-kind handler. */
export function handleEngineEvents(
  events: EngineEventPayload[],
  deps: EngineEventDeps,
) {
  for (const event of events) {
    // A fast engine's events can land before the send returns its run id:
    // adopt the pre-registered lifecycle (and route the run) so no session,
    // runtime, or afterTurn event is dropped.
    if (bindUnboundRun(event)) {
      const lifecycle = runLifecycles.get(event.runId);
      if (lifecycle) {
        settleOrphanedRuns(
          deps.set,
          routeRun(
            event.runId,
            sessionKey(
              lifecycle.engine,
              lifecycle.sessionId,
              lifecycle.workspace.path,
            ),
          ),
        );
      }
      // Events that arrived while this run's ownership was ambiguous are
      // buffered, not queued behind the send result. Ownership is known now,
      // so drain them first: otherwise this event leapfrogs its own prefix
      // and a terminal event's lifecycle cleanup drops the prefix entirely.
      replayBufferedEngineEvents(event.runId, deps);
    }
    const state = deps.get();
    let key = runRouting.get(event.runId);
    if (key) touchRun(event.runId);
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
    if (!key) {
      if ([...pendingRuns.values()].some((lifecycle) => lifecycle.engine === event.engine)) {
        bufferEarlyEvent(event);
      }
      continue;
    }

    if (event.kind !== "done" && event.kind !== "error") {
      dispatchNormalized(event);
    }
    // Engine events reach every attached client, but the running flag is set
    // by the sender's own send path — so an observer (a phone watching the
    // desktop's turn) would never see one. The events are the shared truth:
    // adopt any run still talking, let done/error settle it below. A denial
    // is excluded on purpose: the CLI has stopped to ask, and the grant
    // card's resend has to stay available while it waits.
    if (event.kind !== "done" && event.kind !== "error" && event.kind !== "permission_denied") {
      adoptObservedRun(event, key, deps);
    }

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
