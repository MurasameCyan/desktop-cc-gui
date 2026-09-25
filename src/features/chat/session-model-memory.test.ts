import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "./store";
import { handleEngineEvents, type EngineEventDeps } from "./store/engine-events";
import { sessionKey } from "./store/persistence";
import { EMPTY_SESSION, runRouting } from "./store/stream";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    sendMessage: vi.fn(async () => ({ runId: "run-1", sessionId: null })),
    loadSessionPage: vi.fn(async () => ({ messages: [], nextBefore: null, subagentHistory: [] })),
    listSessions: vi.fn(async () => []),
    listArchivedSessions: vi.fn(async () => []),
    rescanSessions: vi.fn(async () => {}),
    usageRecord: vi.fn(async () => {}),
  },
}));
vi.mock("@/lib/events", () => ({
  listenEngineEvents: vi.fn(async () => () => {}),
  listenSessionsChanged: vi.fn(async () => () => {}),
  listenComputerUseEscape: vi.fn(async () => () => {}),
}));

const WS = "S:\\AIWorker\\demo";
const SID = "01a08ac1-a5b3-4a3f-9a4a-1ac1a08ac1a5";
const KEY = sessionKey("omp", SID, WS);
/** What the picker itself sent: the provider is part of the id. */
const SENT = "agentrouter qunyou/deepseek-v4-flash";


function deps(): EngineEventDeps {
  return {
    set: useChatStore.setState,
    get: useChatStore.getState,
    drainQueue: () => {},
    markUnseenIfBackground: () => {},
    upsertSessionMeta: () => {},
  };
}

describe("a session's provider and model memory", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    runRouting.clear();
    useChatStore.setState({
      openTabs: [],
      active: null,
      unseen: {},
      sessions: [],
      models: { omp: "千刀哥-cc/claude-opus-5" },
      bySession: {},
      streamingByKey: {},
    });
  });


  it("keeps the qualified model when the engine reports the bare name", () => {
    useChatStore.setState({
      bySession: { [KEY]: { ...EMPTY_SESSION, activeModel: SENT } },
    });

    handleEngineEvents(
      [{ runId: "run-2", sessionId: SID, engine: "omp", seq: 1, kind: "model", data: "deepseek-v4-flash" }],
      deps(),
    );
    expect(useChatStore.getState().bySession[KEY]!.activeModel).toBe(SENT);

    // A genuinely different model still lands.
    handleEngineEvents(
      [{ runId: "run-2", sessionId: SID, engine: "omp", seq: 2, kind: "model", data: "glm-5.3" }],
      deps(),
    );
    expect(useChatStore.getState().bySession[KEY]!.activeModel).toBe("glm-5.3");
  });

  it("tracks the effort the run actually reports, ignoring blanks and repeats", () => {
    useChatStore.setState({
      bySession: { [KEY]: { ...EMPTY_SESSION, activeEffort: "medium" } },
    });

    // The engine's own report wins over the launch-time value.
    handleEngineEvents(
      [{ runId: "run-2", sessionId: SID, engine: "omp", seq: 1, kind: "effort", data: "high" }],
      deps(),
    );
    expect(useChatStore.getState().bySession[KEY]!.activeEffort).toBe("high");

    // A repeat of the same level is a no-op: the store object is untouched.
    const before = useChatStore.getState().bySession;
    handleEngineEvents(
      [{ runId: "run-2", sessionId: SID, engine: "omp", seq: 2, kind: "effort", data: "high" }],
      deps(),
    );
    expect(useChatStore.getState().bySession).toBe(before);

    // Blank payloads never clear the known level.
    handleEngineEvents(
      [{ runId: "run-2", sessionId: SID, engine: "omp", seq: 3, kind: "effort", data: "  " }],
      deps(),
    );
    expect(useChatStore.getState().bySession[KEY]!.activeEffort).toBe("high");
  });

});
