import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipc, type SessionMeta } from "@/lib/ipc";
import { setPluginSessionEffort, useChatStore } from "./store";
import { OPEN_TABS_KEY } from "./store/persistence";
import { EMPTY_SESSION } from "./store/stream";
import { handleEngineEvents, type EngineEventDeps } from "./store/engine-events";
import {
  collectBeforeTurnContributions,
  registerRuntimeSwitchHooks,
  registerSessionHooks,
  registerTurnHooks,
} from "@/features/plugins/runtime/hooks";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    sendMessage: vi.fn(async () => ({ runId: "run-1", sessionId: null })),
    interruptSession: vi.fn(async () => true),
    rememberSessionModel: vi.fn(async () => {}),
    rememberSessionEffort: vi.fn(async () => {}),
    rememberSessionProvider: vi.fn(async () => {}),
    listSessions: vi.fn(async () => []),
    listArchivedSessions: vi.fn(async () => []),
    archiveSession: vi.fn(async () => {}),
    restoreSession: vi.fn(async () => {}),
    loadSessionPage: vi.fn(async () => ({ messages: [], nextBefore: null, subagentHistory: [] })),
    loadRemoteSessionPage: vi.fn(async () => ({ messages: [], nextBefore: null, subagentHistory: [] })),
    deleteSession: vi.fn(async () => {}),
    deleteRemoteSession: vi.fn(async () => {}),
    getAppSettings: vi.fn(async () => ({})),
    updateAppSettings: vi.fn(async () => {}),
    rescanSessions: vi.fn(async () => {}),
  },
}));
vi.mock("@/lib/events", () => ({
  listenEngineEvents: vi.fn(async () => () => {}),
  listenSessionsChanged: vi.fn(async () => () => {}),
}));

const WS = "/tmp/ws";
const REGISTERED_WORKSPACE = {
  id: "workspace-7",
  path: WS,
  name: "ws",
  lastOpenedAt: null,
  sortOrder: null,
  groupId: null,
};

function resetStore() {
  localStorage.clear();
  vi.mocked(ipc.sendMessage).mockClear();
  vi.mocked(ipc.interruptSession).mockClear();
  vi.mocked(ipc.loadSessionPage).mockClear();
  vi.mocked(ipc.archiveSession).mockClear();
  vi.mocked(ipc.listArchivedSessions).mockResolvedValue([]);
  useChatStore.setState({
    workspaces: [],
    openTabs: [],
    active: null,
    activeEngine: "claude",
    models: { omp: "kimi-k3" },
    efforts: {},
    providers: {},
    archivedSessionKeys: {},
    bySession: {},
    streamingByKey: {},
    unseen: {},
    drafts: {},
    restoredSessionKeys: {},
    createdSessionKeys: {},
    sessionContributions: {},
    pendingRuntimeSwitch: null,
  });
}

/** Engine-event deps backed by the real store, for event-driven tests. */
function engineDeps(): EngineEventDeps {
  return {
    set: (fn) => useChatStore.setState(fn),
    get: () => useChatStore.getState(),
    drainQueue: () => {},
    markUnseenIfBackground: () => {},
    upsertSessionMeta: () => {},
  };
}

describe("per-session composer selection", () => {
  beforeEach(resetStore);

  it("switching to an existing session retargets the picker to its engine", async () => {
    useChatStore.setState({ activeEngine: "omp" });
    await useChatStore.getState().selectSession("claude", "s-1", WS);
    expect(useChatStore.getState().activeEngine).toBe("claude");
  });

  it("setModel/setEffort stamp the active tab and persist with it", async () => {
    useChatStore.setState({ activeEngine: "omp" });
    useChatStore.getState().startNewChat(WS); // pending omp tab
    await useChatStore.getState().setModel("omp", "fufei/kimi-k3");
    await useChatStore.getState().setEffort("omp", "max");

    const s = useChatStore.getState();
    expect(s.active?.model).toBe("fufei/kimi-k3");
    expect(s.active?.effort).toBe("max");
    // Overrides persist with the tab list (survive restart).
    const persisted = JSON.parse(localStorage.getItem(OPEN_TABS_KEY) ?? "[]");
    expect(persisted[0]).toMatchObject({
      model: "fufei/kimi-k3",
      effort: "max",
    });
  });

  it("re-selecting a session keeps its stamped overrides", async () => {
    useChatStore.setState({ activeEngine: "omp" });
    useChatStore.getState().startNewChat(WS);
    await useChatStore.getState().setModel("omp", "fufei/kimi-k3");
    // Simulate the tab gaining a native session id after the first turn.
    const stamped = { ...useChatStore.getState().active!, sessionId: "s-9" };
    useChatStore.setState({ openTabs: [stamped], active: null });

    await useChatStore.getState().selectSession("omp", "s-9", WS);
    expect(useChatStore.getState().active).toMatchObject({
      model: "fufei/kimi-k3",
    });
  });

  it("send uses the tab override over the engine default", async () => {
    useChatStore.setState({ activeEngine: "omp", models: { omp: "kimi-k3" } });
    useChatStore.getState().startNewChat(WS);
    await useChatStore.getState().setModel("omp", "fufei/kimi-k3");
    await useChatStore.getState().setEffort("omp", "low");

    await useChatStore.getState().send("hi", []);
    expect(vi.mocked(ipc.sendMessage)).toHaveBeenCalledWith(
      expect.objectContaining({
        engine: "omp",
        model: "fufei/kimi-k3",
        effort: "low",
      }),
    );
  });

  it("a tab without overrides sends with the engine default", async () => {
    useChatStore.setState({ activeEngine: "omp", models: { omp: "kimi-k3" } });
    useChatStore.getState().startNewChat(WS);

    await useChatStore.getState().send("hi", []);
    expect(vi.mocked(ipc.sendMessage)).toHaveBeenCalledWith(
      expect.objectContaining({ model: "kimi-k3", effort: null }),
    );
  });

  it("retargeting a pending tab to another engine drops the old overrides", async () => {
    useChatStore.setState({ activeEngine: "omp" });
    useChatStore.getState().startNewChat(WS);
    await useChatStore.getState().setModel("omp", "fufei/kimi-k3");
    await useChatStore.getState().setEffort("omp", "max");

    useChatStore.getState().setActiveEngine("claude");
    const s = useChatStore.getState();
    expect(s.active?.engine).toBe("claude");
    expect(s.active?.model).toBeUndefined();
    expect(s.active?.effort).toBeUndefined();
  });
});

describe("stop during an in-flight send", () => {
  beforeEach(resetStore);

  it("kills the run when Stop is pressed before sendMessage resolves", async () => {
    // Existing resumed session: the tab already carries a native id, so the
    // send takes the run-routing branch (no id adoption).
    const tab = { engine: "omp", sessionId: "sess-42", workspacePath: WS };
    useChatStore.setState({ activeEngine: "omp", openTabs: [tab], active: tab });

    // Hold sendMessage open so Stop lands while the invoke is still pending —
    // exactly the window where runRouting has no entry for this run yet.
    const { promise, resolve: resolveSend } = Promise.withResolvers<{
      runId: string;
      sessionId: string | null;
    }>();
    vi.mocked(ipc.sendMessage).mockReturnValueOnce(promise);

    const sending = useChatStore.getState().send("hello", []);
    // User presses Stop mid-flight.
    await useChatStore.getState().interrupt();
    expect(useChatStore.getState().bySession["omp/sess-42"]?.interrupted).toBe(
      true,
    );
    // The stop could not have killed anything yet: no run id existed.
    expect(vi.mocked(ipc.interruptSession)).not.toHaveBeenCalledWith("run-9");

    resolveSend({ runId: "run-9", sessionId: null });
    await sending;

    // sendPrompt saw the interrupted flag once the ids materialized and
    // killed the run that Stop could not reach.
    expect(vi.mocked(ipc.interruptSession)).toHaveBeenCalledWith("run-9");
  });

  it("settles the plugin turn once when Stop precedes the launch acknowledgement", async () => {
    const afterTurn = vi.fn();
    const dispose = registerTurnHooks("test.stop-before-ack", { afterTurn });
    const launch = Promise.withResolvers<{ runId: string; sessionId: null }>();
    useChatStore.setState({ workspaces: [REGISTERED_WORKSPACE], activeEngine: "claude" });
    useChatStore.getState().startNewChat(WS);
    vi.mocked(ipc.sendMessage).mockReturnValueOnce(launch.promise);
    const sending = useChatStore.getState().send("hello", []);
    let runId = "";
    try {
      await vi.waitFor(() => expect(ipc.sendMessage).toHaveBeenCalledTimes(1));
      runId = vi.mocked(ipc.sendMessage).mock.calls[0][0].runId!;
      await useChatStore.getState().interrupt();
      expect(afterTurn).not.toHaveBeenCalled();
      launch.resolve({ runId, sessionId: null });
      await sending;
      await vi.waitFor(() => expect(afterTurn).toHaveBeenCalledTimes(1));
      expect(afterTurn).toHaveBeenCalledWith(expect.objectContaining({
        runId,
        status: "cancelled",
      }));
    } finally {
      launch.resolve({ runId, sessionId: null });
      await sending;
      dispose();
    }
  });
});

describe("compactContext and refreshSessionUsage", () => {
  beforeEach(resetStore);

  it("retries a successful but unchanged history read until the final usage is persisted", async () => {
    const key = "codex/delayed-write";
    const previous = { input_tokens: 1000, model_context_window: 200000 };
    const latest = { input_tokens: 90000, model_context_window: 1000000 };
    useChatStore.setState({ bySession: { [key]: { ...EMPTY_SESSION, usage: previous } } });
    vi.mocked(ipc.loadSessionPage)
      .mockResolvedValueOnce({ messages: [{ usage: previous }] } as any)
      .mockResolvedValueOnce({ messages: [{ usage: latest }] } as any);
    await useChatStore.getState().refreshSessionUsage(key);
    expect(useChatStore.getState().bySession[key].usage).toEqual(latest);
  });

  it("refreshes an existing session before sending without waiting for history", async () => {
    const tab = { engine: "codex", sessionId: "before-send", workspacePath: WS };
    const key = "codex/before-send";
    useChatStore.setState({ active: tab, openTabs: [tab], bySession: { [key]: { ...EMPTY_SESSION } } });
    const history = Promise.withResolvers<any>();
    vi.mocked(ipc.loadSessionPage).mockReturnValueOnce(history.promise);
    await useChatStore.getState().send("hello", []);
    expect(ipc.loadSessionPage).toHaveBeenLastCalledWith("codex", "before-send", 100);
    expect(ipc.sendMessage).toHaveBeenCalled();
    history.resolve({ messages: [], nextBefore: null, subagentHistory: [] });
  });

  it("refreshes again when a send fails before any engine event", async () => {
    const tab = { engine: "codex", sessionId: "failed-send", workspacePath: WS };
    const key = "codex/failed-send";
    useChatStore.setState({ active: tab, openTabs: [tab], bySession: { [key]: { ...EMPTY_SESSION } } });
    vi.mocked(ipc.loadSessionPage).mockClear();
    vi.mocked(ipc.sendMessage).mockRejectedValueOnce(new Error("spawn failed"));
    await useChatStore.getState().send("hello", []);
    expect(ipc.loadSessionPage).toHaveBeenCalledTimes(2);
    expect(useChatStore.getState().bySession[key].streaming).toBe(false);
  });

  it("refreshing a closed background session reads its own id, not the active tab", async () => {
    const active = { engine: "claude", sessionId: "foreground", workspacePath: WS };
    const key = "codex/background";
    useChatStore.setState({ active, openTabs: [active], bySession: { [key]: { ...EMPTY_SESSION } } });
    await useChatStore.getState().refreshSessionUsage(key);
    expect(ipc.loadSessionPage).toHaveBeenLastCalledWith("codex", "background", 100);
  });

  it("a slow refresh cannot overwrite newer live usage or lose a 1M window", async () => {
    const key = "codex/refresh-race";
    const oldUsage = { input_tokens: 1000, model_context_window: 1_000_000 };
    useChatStore.setState({ bySession: { [key]: { ...EMPTY_SESSION, usage: oldUsage } } });
    const history = Promise.withResolvers<any>();
    vi.mocked(ipc.loadSessionPage).mockReturnValueOnce(history.promise);
    const refreshing = useChatStore.getState().refreshSessionUsage(key);
    const latestUsage = { input_tokens: 90000, model_context_window: 1_000_000 };
    useChatStore.setState({ bySession: { [key]: { ...EMPTY_SESSION, usage: latestUsage } } });
    history.resolve({ messages: [{ usage: { input_tokens: 2000 } }] });
    await refreshing;
    expect(useChatStore.getState().bySession[key].usage).toBe(latestUsage);
    vi.mocked(ipc.loadSessionPage).mockResolvedValueOnce({ messages: [{ usage: { input_tokens: 91000 } }] } as any);
    await useChatStore.getState().refreshSessionUsage(key);
    expect(useChatStore.getState().bySession[key].usage).toEqual({ input_tokens: 91000, model_context_window: 1_000_000 });
  });

  it("a claude turn-sum settles down to the smaller occupancy the file holds", async () => {
    const key = "claude/turn-sum";
    // What a claude result line carries: every request of the turn added up
    // (billing), which is far past the window the meter measures against. The
    // transcript keeps the last request's prompt — the real occupancy.
    const turnSum = {
      input_tokens: 51_755,
      output_tokens: 5_713,
      cache_read_input_tokens: 4_900_000,
      model_context_window: 1_000_000,
    };
    useChatStore.setState({ bySession: { [key]: { ...EMPTY_SESSION, usage: turnSum } } });
    const occupancy = {
      input_tokens: 600,
      output_tokens: 927,
      cache_read_input_tokens: 162_176,
    };
    vi.mocked(ipc.loadSessionPage).mockResolvedValueOnce({
      messages: [{ seq: 1, role: "assistant", text: "hi", ts: "2026-09-18T00:00:00Z", usage: occupancy }],
    } as any);
    await useChatStore.getState().refreshSessionUsage(key);
    // The decrease must land — a re-read is newer than a turn sum, not staler —
    // while the window only the live report knew survives the swap.
    expect(useChatStore.getState().bySession[key]?.usage).toEqual({
      ...occupancy,
      model_context_window: 1_000_000,
    });
  });

  it("refreshSessionUsage updates session usage from session history", async () => {
    const tab = { engine: "claude", sessionId: "sess-compact", workspacePath: WS };
    const key = "claude/sess-compact";
    useChatStore.setState({
      activeEngine: "claude",
      openTabs: [tab],
      active: tab,
      bySession: {
        [key]: { ...EMPTY_SESSION },
      },
    });

    const mockUsage = { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 };
    vi.mocked(ipc.loadSessionPage).mockResolvedValueOnce({
      messages: [
        {
          seq: 1,
          role: "assistant",
          text: "hello",
          ts: "2026-09-10T12:00:00Z",
          usage: mockUsage,
        },
      ] as any,
      nextBefore: null,
      subagentHistory: [],
    });

    await useChatStore.getState().refreshSessionUsage(key);

    expect(ipc.loadSessionPage).toHaveBeenCalledWith("claude", "sess-compact", 100);
    expect(useChatStore.getState().bySession[key]?.usage).toEqual(mockUsage);
  });

  it("loadHistoryPage routes remote metas through loadRemoteSessionPage", async () => {
    useChatStore.setState({
      sessions: [
        {
          engine: "codex",
          sessionId: "remote-1",
          workspacePath: WS,
          filePath: "",
          fileSize: 0,
          fileMtimeMs: 0,
          title: "remote",
          preview: "",
          createdAt: null,
          updatedAt: null,
          messageCount: 0,
          pinned: false,
          customTitle: null,
          remote: true,
          remotePath: "/home/u/x.jsonl",
        } as any,
      ],
    });
    await useChatStore.getState().selectSession("codex", "remote-1", WS);
    expect(ipc.loadRemoteSessionPage).toHaveBeenCalledWith(WS, "codex", "remote-1", "/home/u/x.jsonl", 100, undefined);
    expect(ipc.loadSessionPage).not.toHaveBeenCalledWith("codex", "remote-1", 100);
  });

  it("deleteSession routes remote metas through deleteRemoteSession", async () => {
    const remoteMeta: SessionMeta = {
      engine: "dsh",
      sessionId: "remote-1",
      workspacePath: WS,
      filePath: "",
      fileSize: 0,
      fileMtimeMs: 0,
      title: "remote",
      preview: "",
      createdAt: null,
      updatedAt: null,
      messageCount: 0,
      pinned: false,
      customTitle: null,
      remote: true,
      remotePath: "/home/u/.dsh/sessions/-tmp-ws/s-1/session.jsonl.zstd",
    };
    const localMeta: SessionMeta = { ...remoteMeta, engine: "omp", sessionId: "local-1", remote: false, remotePath: undefined };
    useChatStore.setState({ sessions: [remoteMeta, localMeta] });

    await useChatStore.getState().deleteSession("dsh", "remote-1");
    expect(ipc.deleteRemoteSession).toHaveBeenCalledWith(
      WS,
      "dsh",
      "remote-1",
      "/home/u/.dsh/sessions/-tmp-ws/s-1/session.jsonl.zstd",
    );
    expect(ipc.deleteSession).not.toHaveBeenCalled();
    expect(useChatStore.getState().sessions.map((s) => s.sessionId)).toEqual(["local-1"]);

    await useChatStore.getState().deleteSession("omp", "local-1");
    expect(ipc.deleteSession).toHaveBeenCalledWith("omp", "local-1");
    expect(useChatStore.getState().sessions).toEqual([]);
  });

  it("archiveSession hides the row, closes its tab, and remembers the key", async () => {
    const meta: SessionMeta = {
      engine: "codex",
      sessionId: "archive-1",
      workspacePath: WS,
      filePath: "/tmp/archive-1.jsonl",
      fileSize: 1,
      fileMtimeMs: 1,
      title: "archive me",
      preview: "",
      createdAt: 1,
      updatedAt: 2,
      messageCount: 1,
      pinned: false,
      customTitle: null,
    };
    const tab = { engine: meta.engine, sessionId: meta.sessionId, workspacePath: WS };
    useChatStore.setState({
      sessions: [meta],
      openTabs: [tab],
      active: tab,
      bySession: { "codex/archive-1": { ...EMPTY_SESSION } },
    });

    await useChatStore.getState().archiveSession(meta);

    expect(ipc.archiveSession).toHaveBeenCalledWith(meta);
    expect(useChatStore.getState().sessions).toEqual([]);
    expect(useChatStore.getState().openTabs).toEqual([]);
    expect(useChatStore.getState().active).toBeNull();
    expect(useChatStore.getState().archivedSessionKeys["codex/archive-1"]).toBe(true);
    expect(useChatStore.getState().bySession["codex/archive-1"]).toBeUndefined();
  });

  it("pinModels(updates, false) 只更新内存 models,不触碰 persisted 默认", async () => {
    vi.mocked(ipc.updateAppSettings).mockClear();
    await useChatStore.getState().pinModels({ omp: "remote-only-model" }, false);
    expect(useChatStore.getState().models.omp).toBe("remote-only-model");
    expect(ipc.updateAppSettings).not.toHaveBeenCalled();
  });

  it("pinModels 默认 persist:写 settings.defaultModels", async () => {
    vi.mocked(ipc.updateAppSettings).mockClear();
    await useChatStore.getState().pinModels({ omp: "m1" });
    expect(useChatStore.getState().models.omp).toBe("m1");
    expect(ipc.updateAppSettings).toHaveBeenCalledWith(
      expect.objectContaining({ defaultModels: expect.objectContaining({ omp: "m1" }) }),
    );
  });

  it("compactContext sends /compact and invokes refreshSessionUsage after compaction finishes", async () => {
    const tab = { engine: "claude", sessionId: "sess-compact", workspacePath: WS };
    const key = "claude/sess-compact";
    useChatStore.setState({
      activeEngine: "claude",
      openTabs: [tab],
      active: tab,
      bySession: {
        [key]: {
          ...EMPTY_SESSION,
          usage: { inputTokens: 50000, outputTokens: 5000 },
        },
      },
      streamingByKey: {},
    });

    const newUsage = { inputTokens: 10000, outputTokens: 1000 };
    vi.mocked(ipc.loadSessionPage).mockResolvedValueOnce({
      messages: [
        {
          seq: 2,
          role: "assistant",
          text: "compacted",
          ts: "2026-09-10T12:00:00Z",
          usage: newUsage,
        },
      ] as any,
      nextBefore: null,
      subagentHistory: [],
    });

    const compactPromise = useChatStore.getState().compactContext(key);

    // The optimistic row lands synchronously; the send itself follows the
    // turn-contribution collection on the next microtask.
    await vi.waitFor(() =>
      expect(ipc.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: "/compact" }),
      ),
    );

    // Simulate completion by clearing streamingByKey
    useChatStore.setState({
      streamingByKey: {},
      bySession: {
        ...useChatStore.getState().bySession,
        [key]: {
          ...useChatStore.getState().bySession[key]!,
          streaming: false,
        },
      },
    });

    await compactPromise;

    expect(ipc.loadSessionPage).toHaveBeenCalledWith("claude", "sess-compact", 100);
    expect(useChatStore.getState().bySession[key]?.usage).toEqual(newUsage);
  });
});

describe("model selection is per session", () => {
  beforeEach(resetStore);

  const sess = (id: string) => ({
    engine: "omp",
    sessionId: id,
    workspacePath: WS,
  });

  it("picking a model inside a session leaves the engine default alone", async () => {
    // Two sessions of the SAME CLI: the complaint is that choosing a model in
    // one changed the other, because the pick was written as the engine-wide
    // default.
    const a = sess("s-a");
    const b = sess("s-b");
    useChatStore.setState({ activeEngine: "omp", openTabs: [a, b], active: a });

    await useChatStore.getState().setModel("omp", "deepseek-v4-flash");

    expect(useChatStore.getState().models.omp).toBe("kimi-k3");
    const tabA = useChatStore.getState().openTabs.find((t) => t.sessionId === "s-a");
    const tabB = useChatStore.getState().openTabs.find((t) => t.sessionId === "s-b");
    expect(tabA?.model).toBe("deepseek-v4-flash");
    expect(tabB?.model).toBeUndefined();
  });

  it("a pending new chat still edits the engine default", async () => {
    // The starting choice for future conversations is made on a new-chat tab.
    useChatStore.setState({ activeEngine: "omp", openTabs: [], active: null });
    useChatStore.getState().startNewChat(WS);
    await useChatStore.getState().setModel("omp", "glm-5.3-flash");

    expect(useChatStore.getState().models.omp).toBe("glm-5.3-flash");
    // and the pending tab carries it too
    expect(useChatStore.getState().active?.model).toBe("glm-5.3-flash");
  });

  it("continues a session on the model that session actually ran", async () => {
    const a = sess("s-a");
    useChatStore.setState({
      activeEngine: "omp",
      openTabs: [a],
      active: a,
      models: { omp: "kimi-k3" },
      bySession: {
        "omp/s-a": {
          ...EMPTY_SESSION,
          messages: [
            { seq: 1, role: "assistant", text: "hi", ts: null, model: "glm-5.3-flash" },
          ],
        },
      },
    });

    await useChatStore.getState().send("next", []);

    // Not the engine default: the conversation keeps its own model.
    expect(vi.mocked(ipc.sendMessage)).toHaveBeenCalledWith(
      expect.objectContaining({ model: "glm-5.3-flash" }),
    );
  });

  it("prefers the session's reported model over its history", async () => {
    const a = sess("s-a");
    useChatStore.setState({
      activeEngine: "omp",
      openTabs: [a],
      active: a,
      models: { omp: "kimi-k3" },
      bySession: {
        "omp/s-a": {
          ...EMPTY_SESSION,
          activeModel: "gpt-5.6-luna",
          messages: [
            { seq: 1, role: "assistant", text: "hi", ts: null, model: "glm-5.3-flash" },
          ],
        },
      },
    });

    await useChatStore.getState().send("next", []);
    expect(vi.mocked(ipc.sendMessage)).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-5.6-luna" }),
    );
  });

  it("an explicit per-session pick wins over the reported model", async () => {
    const a = sess("s-a");
    useChatStore.setState({
      activeEngine: "omp",
      openTabs: [{ ...a, model: "claude-opus-5" }],
      active: { ...a, model: "claude-opus-5" },
      models: { omp: "kimi-k3" },
      bySession: {
        "omp/s-a": { ...EMPTY_SESSION, activeModel: "gpt-5.6-luna" },
      },
    });

    await useChatStore.getState().send("next", []);
    expect(vi.mocked(ipc.sendMessage)).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-opus-5" }),
    );
  });
  it("keeps an existing session's effort out of the engine default and sibling sessions", async () => {
    const a = sess("s-a");
    const b = sess("s-b");
    useChatStore.setState({
      activeEngine: "omp",
      openTabs: [a, b],
      active: a,
      efforts: { omp: "medium" },
    });

    await useChatStore.getState().setEffort("omp", "max");

    expect(useChatStore.getState().efforts.omp).toBe("medium");
    expect(vi.mocked(ipc.rememberSessionEffort)).toHaveBeenCalledWith(
      "omp",
      "s-a",
      "max",
    );
    useChatStore.setState({ active: b });
    await useChatStore.getState().send("next", []);
    expect(vi.mocked(ipc.sendMessage)).toHaveBeenLastCalledWith(
      expect.objectContaining({ effort: "medium" }),
    );
  });

  it("ignores a stale persisted tab effort for a native session", async () => {
    const stale = { ...sess("s-a"), effort: "max" as const };
    useChatStore.setState({
      activeEngine: "omp",
      openTabs: [stale],
      active: stale,
      efforts: { omp: "medium" },
      bySession: {
        "omp/s-a": { ...EMPTY_SESSION, activeEffort: "low" },
      },
    });

    await useChatStore.getState().send("next", []);

    expect(vi.mocked(ipc.sendMessage)).toHaveBeenCalledWith(
      expect.objectContaining({ effort: "low" }),
    );
  });
});

describe("refreshSessions and the not-yet-scanned session", () => {
  beforeEach(() => {
    resetStore();
    useChatStore.setState({ sessions: [], engines: [], workspaces: [] });
    vi.mocked(ipc.listSessions).mockResolvedValue([]);
  });

  const meta = (sessionId: string, title = "新会话"): SessionMeta => ({
    engine: "omp",
    sessionId,
    workspacePath: WS,
    filePath: "",
    fileSize: 0,
    fileMtimeMs: 0,
    title,
    preview: "",
    createdAt: 1,
    updatedAt: 2,
    messageCount: 1,
    pinned: false,
    customTitle: null,
  });

  it("keeps the new chat's row when a refresh lands before the scanner ingests its file", async () => {
    // The reported bug: the engine announces the session id and the sidebar
    // row is upserted optimistically, but adopting the id also files the
    // model (remember_session_model → sessions_changed) and the refresh it
    // triggers replaced the list with a scan that has not seen the new file
    // yet — the row vanished until a manual sync.
    useChatStore.setState({
      sessions: [meta("s-new")],
      bySession: { "omp/s-new": { ...EMPTY_SESSION, streaming: true } },
    });

    await useChatStore.getState().refreshSessions();

    expect(
      useChatStore.getState().sessions.map((s) => s.sessionId),
    ).toContain("s-new");
  });

  it("still drops rows with no local state (external delete cleanup)", async () => {
    useChatStore.setState({ sessions: [meta("s-gone")] });

    await useChatStore.getState().refreshSessions();

    expect(useChatStore.getState().sessions).toEqual([]);
  });

  it("lets the scanned row win once the scanner ingests the file", async () => {
    useChatStore.setState({
      sessions: [meta("s-new")],
      bySession: { "omp/s-new": { ...EMPTY_SESSION, streaming: true } },
    });
    vi.mocked(ipc.listSessions).mockResolvedValue([
      { ...meta("s-new", "VPN 一直超时"), filePath: "s.jsonl" },
    ]);

    await useChatStore.getState().refreshSessions();

    const sessions = useChatStore.getState().sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      sessionId: "s-new",
      title: "VPN 一直超时",
      filePath: "s.jsonl",
    });
  });

  it("does not preserve an archived live row and closes its open tab", async () => {
    const archived = meta("s-archived");
    const tab = { engine: "omp", sessionId: "s-archived", workspacePath: WS };
    useChatStore.setState({
      sessions: [archived],
      openTabs: [tab],
      active: tab,
      bySession: { "omp/s-archived": { ...EMPTY_SESSION } },
    });
    vi.mocked(ipc.listArchivedSessions).mockResolvedValue([archived]);

    await useChatStore.getState().refreshSessions();

    expect(useChatStore.getState().sessions).toEqual([]);
    expect(useChatStore.getState().openTabs).toEqual([]);
    expect(useChatStore.getState().active).toBeNull();
    expect(useChatStore.getState().bySession["omp/s-archived"]).toBeUndefined();
  });

  it.each(["local", "external"])("%s archiving closes plugin state without replaying its old session contribution", async (source) => {
    const session = meta(`archive-${source}`);
    const tab = { engine: session.engine, sessionId: session.sessionId, workspacePath: WS };
    const closed = vi.fn();
    const disposeSession = registerSessionHooks(`test.archive-${source}`, { onClosed: closed });
    let turn = 0;
    const disposeTurn = registerTurnHooks(`test.archive-${source}`, {
      beforeTurn: () => ++turn === 1 ? { promptContributions: [{
        id: "session-memory",
        content: "private archived instructions",
        placement: "request-tail",
        visibility: "internal",
        persistence: "session",
      }] } : undefined,
    });
    useChatStore.setState({ sessions: [session], active: tab, openTabs: [tab], bySession: { [`omp/${session.sessionId}`]: { ...EMPTY_SESSION } } });
    try {
      const runId = `run-archive-${source}`;
      vi.mocked(ipc.sendMessage).mockResolvedValueOnce({ runId, sessionId: session.sessionId });
      await useChatStore.getState().send("first", []);
      handleEngineEvents([{ runId, sessionId: session.sessionId, engine: "omp", seq: 1, kind: "done", data: { usage: null } }], engineDeps());
      if (source === "local") {
        await useChatStore.getState().archiveSession(session);
      } else {
        vi.mocked(ipc.listArchivedSessions).mockResolvedValue([session]);
        await useChatStore.getState().refreshSessions();
      }
      await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
      expect(closed).toHaveBeenCalledWith(expect.objectContaining({ sessionId: session.sessionId }));
      await useChatStore.getState().selectSession("omp", session.sessionId, WS);
      vi.mocked(ipc.sendMessage).mockResolvedValueOnce({ runId: `run-reopened-${source}`, sessionId: session.sessionId });
      await useChatStore.getState().send("reopened", []);
      handleEngineEvents([{ runId: `run-reopened-${source}`, sessionId: session.sessionId, engine: "omp", seq: 1, kind: "done", data: { usage: null } }], engineDeps());
      const request = vi.mocked(ipc.sendMessage).mock.calls.at(-1)![0];
      expect(request.promptContributions.some((item) => item.content === "private archived instructions")).toBe(false);
    } finally {
      disposeTurn();
      disposeSession();
    }
  });
});

describe("setPluginSessionEffort (ctx.sessions.setEffort backend)", () => {
  beforeEach(resetStore);

  it("patches an existing session, persists it, and clears the tab stamp", () => {
    const tab = {
      engine: "codex",
      sessionId: "s-effort",
      workspacePath: WS,
      effort: "low" as const,
    };
    const key = "codex/s-effort";
    useChatStore.setState({
      active: tab,
      openTabs: [tab],
      bySession: { [key]: { ...EMPTY_SESSION } },
    });
    vi.mocked(ipc.rememberSessionEffort).mockClear();

    setPluginSessionEffort("codex", "s-effort", WS, "high");

    expect(useChatStore.getState().bySession[key].activeEffort).toBe("high");
    expect(ipc.rememberSessionEffort).toHaveBeenCalledWith("codex", "s-effort", "high");
    // Stamps cleared so refreshSessions cannot resurrect the old level.
    expect(useChatStore.getState().openTabs[0].effort).toBeUndefined();
    expect(useChatStore.getState().active?.effort).toBeUndefined();
    const persisted = JSON.parse(localStorage.getItem(OPEN_TABS_KEY) ?? "[]");
    expect(persisted[0].effort).toBeUndefined();
  });

  it("rejects unknown sessions instead of minting a ghost entry", () => {
    vi.mocked(ipc.rememberSessionEffort).mockClear();
    expect(() => setPluginSessionEffort("codex", "nope", WS, "high")).toThrow(
      "unknown session",
    );
    expect(useChatStore.getState().bySession["codex/nope"]).toBeUndefined();
    expect(ipc.rememberSessionEffort).not.toHaveBeenCalled();
  });

  it("rejects an empty effort and missing ids", () => {
    const key = "codex/s-effort";
    useChatStore.setState({ bySession: { [key]: { ...EMPTY_SESSION } } });
    expect(() => setPluginSessionEffort("codex", "s-effort", WS, "  ")).toThrow(
      "non-empty",
    );
    expect(() => setPluginSessionEffort("", "s-effort", WS, "high")).toThrow(
      "required",
    );
  });
});

describe("generic plugin chat lifecycle", () => {
  beforeEach(resetStore);

  it("keeps internal prompt contributions out of the optimistic user row", async () => {
    useChatStore.setState({
      workspaces: [{ id: "workspace-7", path: WS, name: "ws", lastOpenedAt: null, sortOrder: null, groupId: null }],
      activeEngine: "claude",
    });
    useChatStore.getState().startNewChat(WS);
    const dispose = registerTurnHooks("test.prompt", {
      beforeTurn: () => ({
        promptContributions: [{
          id: "context",
          content: "internal context",
          placement: "system-tail",
          visibility: "internal",
          persistence: "turn",
        }],
      }),
    });

    await useChatStore.getState().send("visible prompt", []);
    dispose();

    const request = vi.mocked(ipc.sendMessage).mock.calls[0][0];
    expect(request.prompt).toBe("visible prompt");
    expect(request.promptContributions).toEqual([
      expect.objectContaining({ content: "internal context", placement: "system-tail" }),
    ]);
    const visible = Object.values(useChatStore.getState().bySession)[0].messages;
    expect(visible.find((message) => message.role === "user")?.text).toBe("visible prompt");
    expect(visible.some((message) => message.text.includes("internal context"))).toBe(false);
  });

  it("does not confirm prompt contributions when the engine rejects the launch", async () => {
    useChatStore.setState({ workspaces: [REGISTERED_WORKSPACE], activeEngine: "claude" });
    useChatStore.getState().startNewChat(WS);
    const accepted = vi.fn();
    const afterTurn = vi.fn();
    const beforeTurns: string[] = [];
    const contribution = {
      id: "handoff",
      content: "internal handoff",
      placement: "request-tail" as const,
      visibility: "internal" as const,
      persistence: "turn" as const,
      onAccepted: accepted,
    };
    const dispose = registerTurnHooks("test.acceptance", {
      beforeTurn: (event) => {
        beforeTurns.push(event.turnId);
        return { promptContributions: [contribution] };
      },
      afterTurn,
    });
    vi.mocked(ipc.sendMessage).mockRejectedValueOnce(new Error("launch failed"));

    await useChatStore.getState().send("first", []);
    expect(accepted).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(afterTurn).toHaveBeenCalledTimes(1));
    expect(afterTurn).toHaveBeenCalledWith(expect.objectContaining({
      turnId: beforeTurns[0],
      engine: "claude",
      sessionId: null,
      workspace: expect.objectContaining({ id: REGISTERED_WORKSPACE.id, path: WS }),
      status: "failed",
      error: "Error: launch failed",
    }));

    vi.mocked(ipc.sendMessage).mockResolvedValueOnce({ runId: "run-retry", sessionId: null });
    await useChatStore.getState().send("retry", []);
    dispose();
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(beforeTurns[1]).not.toBe(beforeTurns[0]);
    expect(afterTurn).toHaveBeenCalledTimes(1);
  });

  it("emits restored only after loading and created only after a pending tab gains a native id", async () => {
    const restored: string[] = [];
    const created: string[] = [];
    const dispose = registerSessionHooks("test.sessions", {
      onRestored: (event) => { restored.push(event.sessionId); },
      onCreated: (event) => { created.push(event.sessionId ?? ""); },
    });
    useChatStore.setState({
      workspaces: [{ id: "workspace-7", path: WS, name: "ws", lastOpenedAt: null, sortOrder: null, groupId: null }],
    });

    await useChatStore.getState().selectSession("claude", "restored-1", WS);
    await Promise.resolve();
    expect(restored).toEqual(["restored-1"]);
    expect(created).toEqual([]);

    useChatStore.setState({ activeEngine: "claude", openTabs: [], active: null });
    useChatStore.getState().startNewChat(WS);
    vi.mocked(ipc.sendMessage).mockResolvedValueOnce({ runId: "run-created", sessionId: "native-1" });
    await useChatStore.getState().send("hello", []);
    await Promise.resolve();
    dispose();
    expect(created).toEqual(["native-1"]);
  });

  it("emits created once when a later session event supplies the native id", async () => {
    const created = vi.fn();
    const dispose = registerSessionHooks("test.delayed-created", { onCreated: created });
    useChatStore.setState({ workspaces: [REGISTERED_WORKSPACE], activeEngine: "claude" });
    useChatStore.getState().startNewChat(WS);
    vi.mocked(ipc.sendMessage).mockResolvedValueOnce({ runId: "run-delayed", sessionId: null });

    await useChatStore.getState().send("hello", []);
    const sessionEvent = {
      runId: "run-delayed",
      sessionId: null,
      engine: "claude",
      seq: 1,
      kind: "session" as const,
      data: "native-delayed",
    };
    handleEngineEvents([sessionEvent, sessionEvent], engineDeps());
    await Promise.resolve();
    dispose();

    expect(created).toHaveBeenCalledTimes(1);
    expect(created).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "native-delayed",
      workspace: expect.objectContaining({ id: "workspace-7", path: WS }),
    }));
  });

  it("runs a pending switch before the first target launch and after it launches", async () => {
    const order: string[] = [];
    const dispose = registerRuntimeSwitchHooks("test.switch", {
      beforeSwitch: () => { order.push("before"); },
      afterSwitch: () => { order.push("after"); },
    });
    useChatStore.setState({
      workspaces: [{ id: "workspace-7", path: WS, name: "ws", lastOpenedAt: null, sortOrder: null, groupId: null }],
      activeEngine: "claude",
    });
    useChatStore.getState().startNewChat(WS);
    useChatStore.getState().setActiveEngine("codex");
    vi.mocked(ipc.sendMessage).mockImplementationOnce(async () => {
      order.push("launch");
      return { runId: "run-switch", sessionId: null };
    });

    await useChatStore.getState().send("go", []);
    await Promise.resolve();
    dispose();
    expect(order).toEqual(["before", "launch", "after"]);
  });

  it("does not clear a newer runtime switch when an older launch resolves", async () => {
    const firstLaunch = Promise.withResolvers<{ runId: string; sessionId: null }>();
    const older = {
      sourceEngine: "claude",
      targetEngine: "codex",
      sourceSessionId: "source-a",
      targetSessionId: null,
      workspacePath: WS,
    };
    useChatStore.setState({
      workspaces: [REGISTERED_WORKSPACE],
      activeEngine: "codex",
      openTabs: [{ engine: "codex", sessionId: null, workspacePath: WS }],
      active: { engine: "codex", sessionId: null, workspacePath: WS },
      pendingRuntimeSwitch: older,
    });
    vi.mocked(ipc.sendMessage).mockReturnValueOnce(firstLaunch.promise);

    const sending = useChatStore.getState().send("go", []);
    await vi.waitFor(() => expect(ipc.sendMessage).toHaveBeenCalledTimes(1));
    // A second switch can carry the same values as the one this send captured,
    // so only reference identity can tell the completing send that the slot it
    // owns is no longer current.
    const newer = { ...older };
    useChatStore.setState({ pendingRuntimeSwitch: newer });
    firstLaunch.resolve({ runId: "run-old-switch", sessionId: null });
    await sending;

    expect(useChatStore.getState().pendingRuntimeSwitch).toBe(newer);
  });

  it("preserves a restored source when a picker change starts a target chat", async () => {
    const order: string[] = [];
    const dispose = registerRuntimeSwitchHooks("test.restored-switch", {
      beforeSwitch: (event) => { order.push(`before:${event.sourceEngine}->${event.targetEngine}`); },
      afterSwitch: () => { order.push("after"); },
    });
    useChatStore.setState({ workspaces: [REGISTERED_WORKSPACE], activeEngine: "claude" });
    await useChatStore.getState().selectSession("claude", "source-1", WS);
    useChatStore.getState().setActiveEngine("codex");
    useChatStore.getState().startNewChat(WS);
    vi.mocked(ipc.sendMessage).mockImplementationOnce(async () => {
      order.push("launch");
      return { runId: "run-restored-switch", sessionId: null };
    });

    await useChatStore.getState().send("go", []);
    dispose();

    expect(order).toEqual(["before:claude->codex", "launch", "after"]);
  });
});

describe("switch ordering and turn lifecycle", () => {
  beforeEach(resetStore);

  it("prepares the switch handoff before collecting the first target turn", async () => {
    const order: string[] = [];
    const disposeSwitch = registerRuntimeSwitchHooks("test.order.switch", {
      beforeSwitch: () => { order.push("beforeSwitch"); },
      afterSwitch: () => { order.push("afterSwitch"); },
    });
    const disposeTurn = registerTurnHooks("test.order.turn", {
      beforeTurn: () => { order.push("beforeTurn"); },
    });
    useChatStore.setState({ workspaces: [REGISTERED_WORKSPACE], activeEngine: "claude" });
    useChatStore.getState().startNewChat(WS);
    useChatStore.getState().setActiveEngine("codex");
    vi.mocked(ipc.sendMessage).mockImplementationOnce(async () => {
      order.push("send");
      return { runId: "run-order", sessionId: null };
    });

    await useChatStore.getState().send("go", []);
    disposeSwitch();
    disposeTurn();

    expect(order).toEqual(["beforeSwitch", "beforeTurn", "send", "afterSwitch"]);
  });

  it("delivers early terminal hooks only after the launch acknowledgement", async () => {
    const launch = Promise.withResolvers<{ runId: string; sessionId: string }>();
    const observations: string[] = [];
    let turnId = "";
    const runtimeTurnIds: string[] = [];
    const settledTurnIds: string[] = [];
    const dispose = registerTurnHooks("test.early-ack", {
      beforeTurn: (event) => {
        turnId = event.turnId;
        return { promptContributions: [{ id: "receipt", content: "private instructions", placement: "request-tail", visibility: "internal", persistence: "turn", onAccepted: () => { observations.push("accepted"); } }] };
      },
      onRuntimeEvent: (event) => { runtimeTurnIds.push(event.turnId); },
      afterTurn: (event) => { observations.push("settled"); settledTurnIds.push(event.turnId); },
    });
    useChatStore.setState({ workspaces: [REGISTERED_WORKSPACE], activeEngine: "claude" });
    useChatStore.getState().startNewChat(WS);
    vi.mocked(ipc.sendMessage).mockReturnValueOnce(launch.promise);
    const sending = useChatStore.getState().send("hi", []);
    try {
      await vi.waitFor(() => expect(ipc.sendMessage).toHaveBeenCalledTimes(1));
      handleEngineEvents([
        { runId: "run-early-ack", sessionId: null, engine: "claude", seq: 1, kind: "delta", data: "visible reply" },
        { runId: "run-early-ack", sessionId: null, engine: "claude", seq: 2, kind: "done", data: { usage: null } },
      ], engineDeps());
      await Promise.resolve();
      expect(useChatStore.getState().bySession[`new:claude:${WS}`].streaming).toBe(false);
      expect(observations).toEqual([]);
      launch.resolve({ runId: "run-early-ack", sessionId: "native-early-ack" });
      await sending;
      expect(observations).toEqual(["accepted", "settled"]);
      expect(runtimeTurnIds).toEqual([turnId]);
      expect(settledTurnIds).toEqual([turnId]);
    } finally {
      launch.resolve({ runId: "run-early-ack", sessionId: "native-early-ack" });
      await sending;
      dispose();
    }
  });

  it("binds a fast engine's done event that arrives before sendMessage resolves", async () => {
    const afterTurn = vi.fn();
    const dispose = registerTurnHooks("test.early", { afterTurn });
    useChatStore.setState({ workspaces: [REGISTERED_WORKSPACE], activeEngine: "claude" });
    useChatStore.getState().startNewChat(WS);
    vi.mocked(ipc.sendMessage).mockImplementationOnce(async () => {
      // The engine finishes its work and reports `done` while the send invoke
      // is still in flight: no SendResult run id exists yet.
      handleEngineEvents(
        [{ runId: "run-early", sessionId: null, engine: "claude", seq: 1, kind: "done", data: { usage: null } }],
        engineDeps(),
      );
      return { runId: "run-early", sessionId: null };
    });

    await useChatStore.getState().send("hi", []);
    await vi.waitFor(() => expect(afterTurn).toHaveBeenCalledTimes(1));
    dispose();

    expect(afterTurn).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-early", status: "completed" }),
    );
  });
});

describe("session restore and workspace fallback", () => {
  beforeEach(resetStore);

  it("dispatches restored once even when the session's messages are cached", async () => {
    const restored: string[] = [];
    const dispose = registerSessionHooks("test.cached-restored", {
      onRestored: (event) => { restored.push(event.sessionId); },
    });
    useChatStore.setState({
      workspaces: [REGISTERED_WORKSPACE],
      bySession: {
        "claude/sess-cached": {
          ...EMPTY_SESSION,
          messages: [{ seq: 1, role: "assistant", text: "hi", ts: null }],
        },
      },
    });

    await useChatStore.getState().selectSession("claude", "sess-cached", WS);
    await useChatStore.getState().selectSession("claude", "sess-cached", WS);
    await Promise.resolve();
    dispose();

    expect(restored).toEqual(["sess-cached"]);
    // The cached messages skipped the backend reload.
    expect(ipc.loadSessionPage).not.toHaveBeenCalled();
  });

  it("still runs hooks for a workspace the host has not registered", async () => {
    const workspaceIds: string[] = [];
    const disposeSessions = registerSessionHooks("test.fallback-ws", {
      onCreated: (event) => { workspaceIds.push(event.workspace.id); },
    });
    const disposeTurn = registerTurnHooks("test.fallback-turn", {
      beforeTurn: () => ({
        promptContributions: [{
          id: "fallback",
          content: "unregistered workspace context",
          placement: "system-tail",
          visibility: "internal",
          persistence: "turn",
        }],
      }),
    });
    useChatStore.setState({ workspaces: [], activeEngine: "claude" });

    useChatStore.getState().startNewChat(WS);
    vi.mocked(ipc.sendMessage).mockResolvedValueOnce({ runId: "run-ws-1", sessionId: "ws-native-1" });
    await useChatStore.getState().send("one", []);
    useChatStore.getState().startNewChat(WS);
    vi.mocked(ipc.sendMessage).mockResolvedValueOnce({ runId: "run-ws-2", sessionId: "ws-native-2" });
    await useChatStore.getState().send("two", []);
    await Promise.resolve();
    disposeSessions();
    disposeTurn();

    expect(vi.mocked(ipc.sendMessage).mock.calls[0][0].promptContributions).toEqual([
      expect.objectContaining({ content: "unregistered workspace context" }),
    ]);
    // The path-derived id is stable for the same directory.
    expect(workspaceIds).toHaveLength(2);
    expect(workspaceIds[0]).toMatch(/\S/);
    expect(workspaceIds[0]).toBe(workspaceIds[1]);
  });
});

describe("session-scoped internal contributions", () => {
  beforeEach(resetStore);

  const contribution = (content: string) => ({
    id: "task-state",
    content,
    placement: "system-tail" as const,
    visibility: "internal" as const,
    persistence: "session" as const,
  });

  it("preserves and withdraws instructions whose identities resemble object prototype keys", async () => {
    useChatStore.setState({ activeEngine: "claude" });
    useChatStore.getState().startNewChat(WS);
    const protocol = { ...contribution("retained task instructions"), id: "__proto__" };
    let first = true;
    const dispose = registerTurnHooks("constructor", {
      beforeTurn: () => {
        if (!first) return;
        first = false;
        return { promptContributions: [protocol] };
      },
    });
    try {
      vi.mocked(ipc.sendMessage).mockResolvedValueOnce({ runId: "prototype-first", sessionId: "prototype-session" });
      await useChatStore.getState().send("one", []);
      vi.mocked(ipc.sendMessage).mockResolvedValueOnce({ runId: "prototype-next", sessionId: null });
      await useChatStore.getState().send("two", []);
      expect(vi.mocked(ipc.sendMessage).mock.calls.at(-1)?.[0].promptContributions).toEqual([protocol]);
      dispose();
      vi.mocked(ipc.sendMessage).mockResolvedValueOnce({ runId: "prototype-off", sessionId: null });
      await useChatStore.getState().send("three", []);
      expect(vi.mocked(ipc.sendMessage).mock.calls.at(-1)?.[0].promptContributions)
        .toEqual([expect.objectContaining({ id: "host:internal-instructions-reset:constructor" })]);
    } finally {
      dispose();
    }
  });

  it("withdraws retiring owners on the launch that first overflows the journal", async () => {
    useChatStore.setState({ activeEngine: "claude" });
    useChatStore.getState().startNewChat(WS);
    const previous = Array.from({ length: 32 }, (_, index) => registerTurnHooks(`test.retiring-${index}`, {
      beforeTurn: () => ({ promptContributions: [{ ...contribution("old"), id: `old-${index}`, persistence: "turn" }] }),
    }));
    const next: Array<() => void> = [];
    try {
      vi.mocked(ipc.sendMessage).mockResolvedValueOnce({ runId: "journal-first", sessionId: "journal-session" });
      await useChatStore.getState().send("one", []);
      previous.forEach((dispose) => dispose());
      next.push(...Array.from({ length: 32 }, (_, index) => registerTurnHooks(`test.new-${index}`, {
        beforeTurn: () => ({ promptContributions: [{ ...contribution("new"), id: `new-${index}`, persistence: "turn" }] }),
      })));
      vi.mocked(ipc.sendMessage).mockRejectedValueOnce(new Error("launch rejected"));
      await useChatStore.getState().send("two", []);
      const outgoing = vi.mocked(ipc.sendMessage).mock.calls.at(-1)![0].promptContributions!;
      expect(outgoing[0]).toMatchObject({ id: "host:internal-instructions-reset:" });
      expect(outgoing.slice(1).map((entry) => entry.id)).toEqual(Array.from({ length: 32 }, (_, index) => `new-${index}`));
      vi.mocked(ipc.sendMessage).mockResolvedValueOnce({ runId: "journal-retry", sessionId: null });
      await useChatStore.getState().send("retry", []);
      expect(vi.mocked(ipc.sendMessage).mock.calls.at(-1)![0].promptContributions![0]).toBe(outgoing[0]);
      vi.mocked(ipc.sendMessage).mockResolvedValueOnce({ runId: "journal-next", sessionId: null });
      await useChatStore.getState().send("next", []);
      expect(vi.mocked(ipc.sendMessage).mock.calls.at(-1)![0].promptContributions?.map((entry) => entry.id))
        .toEqual(Array.from({ length: 32 }, (_, index) => `new-${index}`));
    } finally {
      [...previous, ...next].forEach((dispose) => dispose());
    }
  });

  it("withdraws every retired owner after a large turn exhausts the owner journal", async () => {
    useChatStore.setState({ activeEngine: "claude" });
    useChatStore.getState().startNewChat(WS);
    const dispose = Array.from({ length: 40 }, (_, index) => registerTurnHooks(`test.overflow-${index}`, {
      beforeTurn: () => ({ promptContributions: [{ ...contribution("p"), id: `protocol-${index}`, persistence: "turn" }] }),
    }));
    try {
      vi.mocked(ipc.sendMessage).mockResolvedValueOnce({ runId: "overflow-seed", sessionId: "overflow-session" });
      await useChatStore.getState().send("one", []);
      for (const stop of dispose.slice(0, -1)) stop();
      vi.mocked(ipc.sendMessage).mockResolvedValueOnce({ runId: "overflow-clear", sessionId: null });
      await useChatStore.getState().send("two", []);
      const outgoing = vi.mocked(ipc.sendMessage).mock.calls.at(-1)![0].promptContributions!;
      const ids = new Set(outgoing.map((entry) => entry.id));
      for (let index = 0; index < dispose.length - 1; index++) {
        expect(ids.has("host:internal-instructions-reset:") || ids.has(`host:internal-instructions-reset:test.overflow-${index}`)).toBe(true);
      }
      expect(ids.has("protocol-39")).toBe(true);
      vi.mocked(ipc.sendMessage).mockResolvedValueOnce({ runId: "overflow-followup", sessionId: null });
      await useChatStore.getState().send("three", []);
      expect(vi.mocked(ipc.sendMessage).mock.calls.at(-1)![0].promptContributions)
        .toEqual([expect.objectContaining({ id: "protocol-39" })]);
    } finally {
      for (const stop of dispose) stop();
    }
  });

  it("withdraws old turn instructions once and retries withdrawal after a rejected launch", async () => {
    useChatStore.setState({ activeEngine: "claude" });
    useChatStore.getState().startNewChat(WS);
    const dispose = registerTurnHooks("test.turn-instruction", {
      beforeTurn: () => ({ promptContributions: [{ ...contribution("private turn protocol"), persistence: "turn" }] }),
    });
    vi.mocked(ipc.sendMessage).mockResolvedValueOnce({ runId: "protocol-run", sessionId: "protocol-session" });
    await useChatStore.getState().send("one", []);
    dispose();

    vi.mocked(ipc.sendMessage).mockRejectedValueOnce(new Error("launch offline"));
    await useChatStore.getState().send("two", []);
    const withdrawal = vi.mocked(ipc.sendMessage).mock.calls.at(-1)?.[0].promptContributions;
    expect(withdrawal).toEqual([expect.objectContaining({ id: "host:internal-instructions-reset:test.turn-instruction" })]);

    vi.mocked(ipc.sendMessage).mockResolvedValueOnce({ runId: "clear-run", sessionId: null });
    await useChatStore.getState().send("retry", []);
    expect(vi.mocked(ipc.sendMessage).mock.calls.at(-1)?.[0].promptContributions).toEqual(withdrawal);

    vi.mocked(ipc.sendMessage).mockResolvedValueOnce({ runId: "plain-run", sessionId: null });
    await useChatStore.getState().send("three", []);
    expect(vi.mocked(ipc.sendMessage).mock.calls.at(-1)?.[0].promptContributions).toEqual([]);
  });

  it("does not revive a retired session prompt when replacement hooks reuse its source object", async () => {
    useChatStore.setState({ activeEngine: "claude" });
    useChatStore.getState().startNewChat(WS);
    const protocol = contribution("retired instructions");
    const dispose = registerTurnHooks("test.retired-contribution", {
      beforeTurn: () => ({ promptContributions: [protocol] }),
    });
    vi.mocked(ipc.sendMessage).mockResolvedValueOnce({ runId: "retired-run", sessionId: "retired-session" });
    await useChatStore.getState().send("one", []);
    dispose();
    const replacement = registerTurnHooks("test.retired-contribution", {
      beforeTurn: (event) => event.sessionId === "other-native-session" ? { promptContributions: [protocol] } : undefined,
    });
    try {
      await collectBeforeTurnContributions({
        engine: "claude", sessionId: "other-native-session", workspace: REGISTERED_WORKSPACE,
        runId: "other-run", turnId: "other-run", occurredAt: "2026-09-17T00:00:00.000Z",
      });
      vi.mocked(ipc.sendMessage).mockResolvedValueOnce({ runId: "replacement-run", sessionId: null });
      await useChatStore.getState().send("two", []);
      expect(vi.mocked(ipc.sendMessage).mock.calls.at(-1)?.[0].promptContributions)
        .not.toContainEqual(expect.objectContaining({ id: "task-state" }));
    } finally {
      replacement();
    }
  });

  it("re-injects a remembered session contribution and migrates it to the native id", async () => {
    useChatStore.setState({ activeEngine: "claude" });
    useChatStore.getState().startNewChat(WS);
    let turn = 0;
    const dispose = registerTurnHooks("test.session-contribution", {
      beforeTurn: () => {
        turn += 1;
        if (turn === 1) return { promptContributions: [contribution("v1")] };
        if (turn === 2) return { promptContributions: [contribution("v2")] };
        return;
      },
    });

    // Turn 1: pending tab adopts its native id.
    vi.mocked(ipc.sendMessage).mockResolvedValueOnce({ runId: "run-1", sessionId: "native-1" });
    await useChatStore.getState().send("one", []);
    // Turn 2: a fresh contribution with the same id wins.
    vi.mocked(ipc.sendMessage).mockResolvedValueOnce({ runId: "run-2", sessionId: null });
    await useChatStore.getState().send("two", []);
    // Turn 3: the plugin contributes nothing — the session state persists.
    vi.mocked(ipc.sendMessage).mockResolvedValueOnce({ runId: "run-3", sessionId: null });
    await useChatStore.getState().send("three", []);
    dispose();

    const contributions = vi.mocked(ipc.sendMessage).mock.calls.map(
      (call) => call[0].promptContributions,
    );
    expect(contributions[0]).toEqual([expect.objectContaining({ content: "v1" })]);
    expect(contributions[1]).toEqual([expect.objectContaining({ content: "v2" })]);
    expect(contributions[2]).toEqual([expect.objectContaining({ content: "v2" })]);
  });

  it("migrates remembered contributions when the session event adopts the native id", async () => {
    useChatStore.setState({ activeEngine: "claude" });
    useChatStore.getState().startNewChat(WS);
    let turn = 0;
    const dispose = registerTurnHooks("test.session-event-contribution", {
      beforeTurn: () => {
        turn += 1;
        if (turn === 1) return { promptContributions: [contribution("v1")] };
        return;
      },
    });

    // Turn 1: a delta-only engine returns no native id, so the session is
    // still pending and the contribution is remembered under its pending scope.
    vi.mocked(ipc.sendMessage).mockResolvedValueOnce({ runId: "run-ev-1", sessionId: null });
    await useChatStore.getState().send("one", []);
    expect(useChatStore.getState().active?.sessionId).toBeNull();

    // The native id arrives later on the engine `session` event.
    handleEngineEvents(
      [{ runId: "run-ev-1", sessionId: null, engine: "claude", seq: 1, kind: "session", data: "native-ev" }],
      engineDeps(),
    );
    expect(useChatStore.getState().active?.sessionId).toBe("native-ev");
    expect(
      Object.keys(useChatStore.getState().sessionContributions).filter((scope) =>
        scope.startsWith("pending:"),
      ),
    ).toEqual([]);

    // Turn 2: the plugin contributes nothing, yet the session state is re-injected.
    vi.mocked(ipc.sendMessage).mockResolvedValueOnce({ runId: "run-ev-2", sessionId: null });
    await useChatStore.getState().send("two", []);
    dispose();

    const contributions = vi.mocked(ipc.sendMessage).mock.calls.map(
      (call) => call[0].promptContributions,
    );
    expect(contributions[0]).toEqual([expect.objectContaining({ content: "v1" })]);
    expect(contributions[1]).toEqual([expect.objectContaining({ content: "v1" })]);
  });

  it("forgets a session's contributions when its tab closes", async () => {
    useChatStore.setState({ activeEngine: "claude" });
    useChatStore.getState().startNewChat(WS);
    let calls = 0;
    const dispose = registerTurnHooks("test.session-clear", {
      beforeTurn: () => {
        calls += 1;
        if (calls > 1) return;
        return { promptContributions: [contribution("first")] };
      },
    });
    vi.mocked(ipc.sendMessage).mockResolvedValueOnce({ runId: "run-c1", sessionId: "native-c" });
    await useChatStore.getState().send("one", []);
    useChatStore.getState().closeTab("claude", "native-c", WS);
    useChatStore.getState().startNewChat(WS);
    vi.mocked(ipc.sendMessage).mockResolvedValueOnce({ runId: "run-c2", sessionId: null });
    await useChatStore.getState().send("two", []);
    dispose();

    expect(vi.mocked(ipc.sendMessage).mock.calls[1][0].promptContributions).toEqual([]);
  });
});
