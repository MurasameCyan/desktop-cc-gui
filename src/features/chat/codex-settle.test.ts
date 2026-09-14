import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineEventPayload } from "@/lib/events";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    sendMessage: vi.fn(async () => ({ runId: "run-1", sessionId: null })),
    interruptSession: vi.fn(async () => true),
    loadSessionPage: vi.fn(async () => ({ messages: [], nextBefore: null })),
    getAppSettings: vi.fn(async () => ({})),
    updateAppSettings: vi.fn(async () => {}),
    rescanSessions: vi.fn(async () => {}),
  },
}));
vi.mock("@/lib/events", () => ({
  listenEngineEvents: vi.fn(async () => () => {}),
  listenSessionsChanged: vi.fn(async () => () => {}),
}));

// Node 26 ships a built-in `localStorage` that stays undefined unless the
// process was started with --localstorage-file, and it shadows the jsdom one.
// The store reads localStorage at import time, so shim it when it is missing.
if (!globalThis.localStorage) {
  const memory = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => memory.get(k) ?? null,
      setItem: (k: string, v: string) => void memory.set(k, String(v)),
      removeItem: (k: string) => void memory.delete(k),
      clear: () => memory.clear(),
    },
  });
}

const { ipc } = await import("@/lib/ipc");
const { useChatStore } = await import("./store");
const { handleEngineEvents } = await import("./store/engine-events");
type EngineEventDeps = import("./store/engine-events").EngineEventDeps;
const { sessionKey } = await import("./store/persistence");
const { runRouting } = await import("./store/stream");

const WS = "/tmp/ws";
const PENDING = sessionKey("codex", null, WS);
const NATIVE = sessionKey("codex", "tid-1", WS);

function deps(): EngineEventDeps {
  return {
    set: useChatStore.setState,
    get: useChatStore.getState,
    drainQueue: () => {},
    markUnseenIfBackground: () => {},
    upsertSessionMeta: () => {},
  };
}

// The backend stamps the thread id onto every payload once thread.started
// lands, the session event that announces it included.
function ev(
  kind: EngineEventPayload["kind"],
  seq: number,
  data: unknown,
  sessionId: string | null = "tid-1",
): EngineEventPayload {
  return { runId: "run-1", sessionId, engine: "codex", seq, kind, data };
}

function resetStore() {
  localStorage.clear();
  vi.clearAllMocks();
  runRouting.clear();
  useChatStore.setState({
    openTabs: [],
    active: null,
    activeEngine: "codex",
    models: {},
    efforts: {},
    bySession: {},
    streamingByKey: {},
    unseen: {},
    drafts: {},
  });
}

describe("codex turn settling", () => {
  beforeEach(resetStore);

  it("clears streaming once done lands after the run is routed", async () => {
    useChatStore.getState().startNewChat(WS);
    await useChatStore.getState().send("hello", []);

    handleEngineEvents(
      [
        ev("session", 1, "tid-1"),
        ev("message", 2, { role: "assistant", text: "hi there" }),
        ev("done", 3, { usage: null }),
      ],
      deps(),
    );

    const s = useChatStore.getState();
    expect(s.bySession[NATIVE]?.streaming).toBe(false);
    expect(s.streamingByKey[NATIVE]).toBeUndefined();
    expect(s.streamingByKey[PENDING]).toBeUndefined();
  });

  it("keeps the pending turn visible when events beat the send response", async () => {
    useChatStore.getState().startNewChat(WS);
    let resolveSend: (value: { runId: string; sessionId: null }) => void = () => {};
    vi.mocked(ipc.sendMessage).mockImplementation(
      () => new Promise((resolve) => { resolveSend = resolve; }),
    );

    const inflight = useChatStore.getState().send("hello", []);

    // The engine can start streaming before the invoke promise resolves.
    handleEngineEvents(
      [
        ev("session", 1, "tid-1"),
        ev("message", 2, { role: "assistant", text: "hi there" }),
      ],
      deps(),
    );

    resolveSend({ runId: "run-1", sessionId: null });
    await inflight;
    handleEngineEvents([ev("done", 3, { usage: null })], deps());

    const s = useChatStore.getState();
    expect(s.bySession[PENDING]).toBeUndefined();
    expect(s.bySession[NATIVE]?.streaming).toBe(false);
    expect(s.streamingByKey[PENDING]).toBeUndefined();
    expect((s.bySession[NATIVE]?.messages ?? []).some((m) => m.role === "user")).toBe(
      true,
    );
  });
});