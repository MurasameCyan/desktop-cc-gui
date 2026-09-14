import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "./store";
import { handleEngineEvents, type EngineEventDeps } from "./store/engine-events";
import { sessionKey } from "./store/persistence";
import { EMPTY_SESSION, runRouting } from "./store/stream";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    rescanSessions: vi.fn(async () => {}),
    usageRecord: vi.fn(async () => {}),
  },
}));
vi.mock("@/lib/events", () => ({
  listenEngineEvents: vi.fn(async () => () => {}),
  listenSessionsChanged: vi.fn(async () => () => {}),
}));

const KEY = sessionKey("claude", "s-1", "/tmp/ws");

function deps(): EngineEventDeps {
  return {
    set: useChatStore.setState,
    get: useChatStore.getState,
    drainQueue: () => {},
    markUnseenIfBackground: () => {},
    upsertSessionMeta: () => {},
  };
}

function ev(kind: "retry" | "delta" | "done" | "error", seq: number, data: unknown) {
  return { runId: "run-1", sessionId: "s-1", engine: "claude", seq, kind, data };
}

const retry = (seq: number, attempt: number, max = 10) =>
  ev("retry", seq, { attempt, max, message: `API error (HTTP 529); retrying (${attempt}/${max})` });

describe("provider retry progress", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    runRouting.clear();
    useChatStore.setState({
      openTabs: [],
      active: null,
      unseen: {},
      bySession: {
        [KEY]: {
          ...EMPTY_SESSION,
          streaming: true,
          messages: [{ seq: 1, role: "user", text: "go", ts: null }],
        },
      },
      streamingByKey: { [KEY]: true },
    });
  });

  it("shows as progress on the running turn, not as an error", () => {
    handleEngineEvents([retry(2, 3)], deps());

    const s = useChatStore.getState().bySession[KEY]!;
    expect(s.retry).toEqual({
      attempt: 3,
      max: 10,
      message: "API error (HTTP 529); retrying (3/10)",
    });
    expect(s.error).toBeNull();
    expect(s.streaming).toBe(true);
  });

  it("tracks the latest attempt", () => {
    handleEngineEvents([retry(2, 1), retry(3, 2)], deps());

    expect(useChatStore.getState().bySession[KEY]!.retry?.attempt).toBe(2);
  });

  it("clears once the re-issued request streams content", () => {
    handleEngineEvents([retry(2, 4)], deps());
    handleEngineEvents([ev("delta", 3, "back on")], deps());

    expect(useChatStore.getState().bySession[KEY]!.retry).toBeNull();
  });

  it("clears on an explicit end (attempt 0) with nothing streamed yet", () => {
    handleEngineEvents([retry(2, 4)], deps());
    handleEngineEvents([ev("retry", 3, { attempt: 0, max: 0, message: "" })], deps());

    expect(useChatStore.getState().bySession[KEY]!.retry).toBeNull();
  });

  it("does not outlive the turn", () => {
    handleEngineEvents([retry(2, 9)], deps());
    handleEngineEvents([ev("done", 3, { usage: null })], deps());
    expect(useChatStore.getState().bySession[KEY]!.retry).toBeNull();

    useChatStore.setState((s) => ({
      bySession: { ...s.bySession, [KEY]: { ...s.bySession[KEY]!, streaming: true } },
    }));
    handleEngineEvents([retry(4, 10)], deps());
    handleEngineEvents([ev("error", 5, "gave up after 10 attempts")], deps());
    const s = useChatStore.getState().bySession[KEY]!;
    expect(s.retry).toBeNull();
    expect(s.error).toBe("gave up after 10 attempts");
  });
});
