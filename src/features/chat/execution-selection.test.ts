import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PublishedSource, SessionExecutionContext, SessionExecutionTarget } from "@ccgui/plugin-sdk";
import { ipc } from "@/lib/ipc";
import { useChatStore } from "./store";
import { EMPTY_SESSION } from "./store/stream";
import { adoptExecutionContext, refreshExecutionSelection, applyExecutionSelection, executionTargetForTab } from "./store/execution-selection";
import { persistTabs, readPersistedTabs } from "./store/persistence";

vi.mock("@/lib/ipc", () => ({ ipc: {
  getSessionSelection: vi.fn(), setSessionSelection: vi.fn(),
  sendMessage: vi.fn(), listCliSources: vi.fn(),
  loadSessionPage: vi.fn(async () => ({ messages: [], nextBefore: null, subagentHistory: [] })),
} }));
const a = { engine: "claude", sessionId: "a", workspacePath: "/work" };
const b = { ...a, sessionId: "b" };
const target: SessionExecutionTarget = { engineId: "claude", sessionId: "a", workspacePath: "/work", executionTarget: { kind: "local" } };
const context = (version: number, id = "key-a"): SessionExecutionContext => ({ target, selection: {
  version, effort: "high", modelSelection: { source: "contribution", engineId: "claude", sourceId: "plugin:p:s", profileKey: "profile", modelKey: "model", credential: { credentialId: id, credentialRevision: 1, name: id } },
} });
const deps = () => ({ set: useChatStore.setState, get: useChatStore.getState });
beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear();
  vi.mocked(ipc.listCliSources).mockResolvedValue([]);
  vi.mocked(ipc.sendMessage).mockImplementation(async (request) => ({ runId: request.runId!, sessionId: request.target.sessionId }));
  useChatStore.setState({ active: a, openTabs: [a, b], workspaces: [], sessions: [], streamingByKey: {}, bySession: { "claude/a": { ...EMPTY_SESSION }, "claude/b": { ...EMPTY_SESSION } }, actionError: null });
});
describe("authoritative session execution selection", () => {
  it("ignores older whole records without mixing key and effort from another session", () => {
    adoptExecutionContext(deps(), context(4));
    adoptExecutionContext(deps(), context(3, "old-key"));
    expect(useChatStore.getState().bySession["claude/a"].executionSelection).toEqual(context(4).selection);
    expect(useChatStore.getState().bySession["claude/b"].executionSelection).toBeNull();
  });
  it("routes a delayed write to its owner after the foreground tab changes", async () => {
    const gate = Promise.withResolvers<SessionExecutionContext>();
    vi.mocked(ipc.setSessionSelection).mockReturnValueOnce(gate.promise);
    const pending = applyExecutionSelection(deps(), target, context(2).selection!, 1);
    useChatStore.setState({ active: b });
    gate.resolve(context(2)); await pending;
    expect(useChatStore.getState().active).toBe(b);
    expect(useChatStore.getState().bySession["claude/b"].executionSelection).toBeNull();
    expect(useChatStore.getState().bySession["claude/a"].executionSelection?.version).toBe(2);
  });
  it("surfaces compare-and-swap conflicts instead of accepting an optimistic pick", async () => {
    adoptExecutionContext(deps(), context(3));
    vi.mocked(ipc.setSessionSelection).mockRejectedValue(new Error("stale selection version"));
    await expect(applyExecutionSelection(deps(), target, context(4, "other").selection!, 2)).rejects.toThrow("stale selection");
    expect(useChatStore.getState().actionError).toContain("stale selection");
    expect(useChatStore.getState().bySession["claude/a"].executionSelection).toEqual(context(3).selection);
  });
  it("does not resurrect a pending record after its tab retargets", async () => {
    const pending = { engine: "claude", sessionId: null, workspacePath: "/work", pendingId: "pending-a" };
    useChatStore.setState({ active: pending, openTabs: [pending] });
    const old = executionTargetForTab(pending, []);
    useChatStore.setState({ active: { ...pending, pendingId: "pending-b" }, openTabs: [{ ...pending, pendingId: "pending-b" }] });
    adoptExecutionContext(deps(), { ...context(1), target: old });
    expect(useChatStore.getState().bySession["new:claude:/work"]).toBeUndefined();
  });
  it("restores native records from the backend, never from tab storage or global defaults", async () => {
    persistTabs([{ ...a, model: "legacy", effort: "low", provider: "legacy" }], a);
    expect(readPersistedTabs()[0]).not.toHaveProperty("model");
    vi.mocked(ipc.getSessionSelection).mockResolvedValue(context(8));
    const restored = await refreshExecutionSelection(deps(), a);
    expect(restored.selection).toEqual(context(8).selection);
    expect(ipc.setSessionSelection).not.toHaveBeenCalled();
  });
  it("re-reads each owner's newest version for sends and background retries", async () => {
    let versionA = 4;
    vi.mocked(ipc.getSessionSelection).mockImplementation(async (requested) => ({ ...context(requested.sessionId === "a" ? versionA : 12, requested.sessionId === "a" ? "key-a" : "key-b"), target: requested }));
    await useChatStore.getState().send("A first", []);
    useChatStore.setState({ active: b });
    await useChatStore.getState().send("B first", []);
    versionA = 7;
    useChatStore.setState((state) => ({ streamingByKey: {}, bySession: { ...state.bySession, "claude/a": { ...state.bySession["claude/a"], streaming: false } } }));
    await useChatStore.getState().resendLastUser("claude/a");
    expect(vi.mocked(ipc.sendMessage).mock.calls.map(([request]) => [request.target.sessionId, request.selectionVersion])).toEqual([["a", 4], ["b", 12], ["a", 7]]);
    expect(useChatStore.getState().active).toBe(b);
    expect(useChatStore.getState().bySession["claude/a"].executionSelection?.modelSelection).toMatchObject({ credential: { credentialId: "key-a" } });
    expect(useChatStore.getState().bySession["claude/b"].executionSelection?.modelSelection).toMatchObject({ credential: { credentialId: "key-b" } });
  });
  it("blocks the original prompt when native compaction rejects the selected policy", async () => {
    vi.mocked(ipc.getSessionSelection).mockResolvedValue(context(4));
    const source: PublishedSource = { sourceId: "plugin:p:s", pluginId: "p", documentPath: "registry.json", documentVersion: "v1", publicationRevision: "r1", available: true, profiles: [],
      choices: [{ profileKey: "profile", modelKey: "model", label: "Model", selector: { kind: "wire", modelId: "wire-model" }, templateRef: { engineId: "claude", modelId: "wire-model", revision: "r1" }, tokenPolicy: { contextWindowTokens: 200, autoCompactionThresholdTokens: 100 }, capabilities: { images: "unknown", tools: "unknown", effortLevels: ["high"] } }] };
    vi.mocked(ipc.listCliSources).mockResolvedValue([source]);
    vi.mocked(ipc.sendMessage).mockRejectedValue(new Error("Native compaction is unsupported"));
    useChatStore.setState({ bySession: { "claude/a": { ...EMPTY_SESSION, usage: { input_tokens: 150 } } } });
    await useChatStore.getState().send("must not be sent", []);
    expect(vi.mocked(ipc.sendMessage).mock.calls.map(([request]) => request.prompt)).toEqual(["/compact"]);
    expect(useChatStore.getState().bySession["claude/a"].error).toContain("unsupported");
    expect(useChatStore.getState().bySession["claude/a"].messages.some((message) => message.text === "must not be sent")).toBe(false);
  });
  it("restores a pending target's stable identity and replaces it only for a new conversation", () => {
    useChatStore.setState({ activeEngine: "claude" });
    useChatStore.getState().startNewChat("/pending");
    const first = useChatStore.getState().active!;
    expect(readPersistedTabs().find((tab) => tab.workspacePath === "/pending")?.pendingId).toBe(first.pendingId);
    useChatStore.getState().startNewChat("/pending");
    expect(useChatStore.getState().active?.pendingId).toBe(first.pendingId);
    useChatStore.getState().closeTab("claude", null, "/pending");
    useChatStore.getState().startNewChat("/pending");
    expect(useChatStore.getState().active?.pendingId).not.toBe(first.pendingId);
    expect(useChatStore.getState().bySession["new:claude:/pending"].executionSelection).toBeNull();
  });
});
