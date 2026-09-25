import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipc, type SessionMeta } from "@/lib/ipc";
import {
  pluginBus,
  resetPluginBusForTests,
  SESSION_ACTIVATED_TOPIC,
} from "@/features/plugins/runtime/events";
import { useChatStore } from "./store";
import { setPluginSessionEffort } from "@/features/plugins/runtime/session-selection";
import { EMPTY_SESSION } from "./store/stream";

// The hoisted IPC factory must load its stateful test backend before store imports.
vi.mock("@/lib/ipc", async () => ({
  ipc: {
    ...(await import("./store/selection-test-backend")).createSelectionBackend(),
    sendMessage: vi.fn(async () => ({ runId: "run-1", sessionId: null })),
    interruptSession: vi.fn(async () => true),
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
  listenComputerUseEscape: vi.fn(async () => () => {}),
}));

const WS = "/tmp/ws";

function resetStore() {
  localStorage.clear();
  resetPluginBusForTests();
  vi.mocked(ipc.sendMessage).mockClear();
  vi.mocked(ipc.interruptSession).mockClear();
  vi.mocked(ipc.archiveSession).mockClear();
  vi.mocked(ipc.listArchivedSessions).mockResolvedValue([]);
  useChatStore.setState({
    openTabs: [],
    active: null,
    activeEngine: "claude",
    models: { omp: "kimi-k3" },
    efforts: {},
    archivedSessionKeys: {},
    bySession: {},
    streamingByKey: {},
    unseen: {},
    drafts: {},
  });
}

describe("per-session composer selection", () => {
  beforeEach(resetStore);

  it("switching to an existing session retargets the picker to its engine", async () => {
    useChatStore.setState({ activeEngine: "omp" });
    await useChatStore.getState().selectSession("claude", "s-1", WS);
    expect(useChatStore.getState().activeEngine).toBe("claude");
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

  it("announces the picker switch to plugins only when the tab actually retargets", () => {
    const seen: unknown[] = [];
    const dispose = pluginBus.on(SESSION_ACTIVATED_TOPIC, (data) => seen.push(data));
    try {
      useChatStore.setState({ activeEngine: "omp" });
      useChatStore.getState().startNewChat(WS);

      useChatStore.getState().setActiveEngine("claude");
      expect(seen.at(-1)).toEqual({ engine: "claude", sessionId: null });

      // 已经是该引擎：不重复广播（避免插件被无意义的重复事件打扰）
      const afterRetarget = seen.length;
      useChatStore.getState().setActiveEngine("claude");
      expect(seen.length).toBe(afterRetarget);
    } finally {
      dispose();
    }
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
    await vi.waitFor(() => expect(ipc.sendMessage).toHaveBeenCalled());
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
    expect(useChatStore.getState().bySession[key].error).toContain("spawn failed");
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
    await vi.waitFor(() => expect(ipc.sendMessage).toHaveBeenCalled());

    // Verify /compact message was sent
    expect(ipc.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "/compact" }),
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
});

describe("setPluginSessionEffort (ctx.sessions.setEffort backend)", () => {
  beforeEach(resetStore);

  it("updates the same backend record without overwriting another conversation", async () => {
    const tab = { engine: "codex", sessionId: "s-effort", workspacePath: WS };
    useChatStore.setState({ active: tab, openTabs: [tab], bySession: { "codex/s-effort": { ...EMPTY_SESSION } } });
    await setPluginSessionEffort("codex", "s-effort", WS, "high");
    expect(useChatStore.getState().bySession["codex/s-effort"].executionSelection?.effort).toBe("high");
    expect(useChatStore.getState().efforts.codex).toBeUndefined();
  });

  it("rejects unknown sessions instead of minting a ghost entry", async () => {
    await expect(setPluginSessionEffort("codex", "nope", WS, "high")).rejects.toThrow("unknown session");
    expect(useChatStore.getState().bySession["codex/nope"]).toBeUndefined();
  });

  it("rejects an empty effort and missing ids", async () => {
    await expect(setPluginSessionEffort("codex", "s-effort", WS, "  ")).rejects.toThrow("non-empty");
    await expect(setPluginSessionEffort("", "s-effort", WS, "high")).rejects.toThrow("required");
  });
});
