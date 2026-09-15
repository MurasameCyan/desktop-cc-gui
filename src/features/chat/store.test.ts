import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipc, type SessionMeta } from "@/lib/ipc";
import { useChatStore } from "./store";
import { OPEN_TABS_KEY } from "./store/persistence";
import { EMPTY_SESSION } from "./store/stream";
import { handleEngineEvents, type EngineEventDeps } from "./store/engine-events";
import {
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
    listSessions: vi.fn(async () => []),
    loadSessionPage: vi.fn(async () => ({ messages: [], nextBefore: null, subagentHistory: [] })),
    loadRemoteSessionPage: vi.fn(async () => ({ messages: [], nextBefore: null, subagentHistory: [] })),
    getAppSettings: vi.fn(async () => ({})),
    updateAppSettings: vi.fn(async () => {}),
    rescanSessions: vi.fn(async () => {}),
    deleteSession: vi.fn(async () => {}),
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
  useChatStore.setState({
    workspaces: [],
    openTabs: [],
    active: null,
    activeEngine: "claude",
    models: { omp: "kimi-k3" },
    efforts: {},
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
});

describe("compactContext and refreshSessionUsage", () => {
  beforeEach(resetStore);

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
