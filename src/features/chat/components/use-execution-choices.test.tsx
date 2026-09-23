import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ModelEntryProps } from "@ccgui/plugin-sdk";
import { ipc, type EngineInfo } from "@/lib/ipc";
import { useChatStore, sessionKey } from "../store";
import { EMPTY_SESSION } from "../store/stream";
import { useExecutionChoices } from "./use-execution-choices";

vi.mock("@/lib/transport", () => ({ isTauri: () => false, invoke: vi.fn(), listen: async () => () => {} }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const original = useChatStore.getState();
const pending = { engine: "codex", workspacePath: "/preview", sessionId: null, pendingId: "pending-a" };
const engines: EngineInfo[] = ["codex", "omp"].map((id) => ({ id, available: true, enabled: true, supportsImages: true, supportsEffort: true, permissions: ["auto"] }));
const options = engines.map((engine) => ({ id: engine.id, label: engine.id, available: true, disabled: false, disabledReason: "" }));
const refreshNative = async () => {};
let entry: ModelEntryProps;
let root: Root;
let container: HTMLDivElement;
function Subject() {
  const active = useChatStore((state) => state.active);
  const result = useExecutionChoices(active, engines, {}, {}, {}, refreshNative, options, useChatStore.getState().setActiveEngine);
  entry = result.entryProps!;
  return null;
}
beforeEach(async () => {
  vi.spyOn(ipc, "listCliSources").mockResolvedValue([]);
  vi.spyOn(ipc, "getSessionSelection").mockImplementation(async (target) => ({ target, selection: { modelSelection: { source: "native", engineId: target.engineId, modelId: null }, effort: "medium", version: 1 } }));
  useChatStore.setState({ active: pending, activeEngine: "codex", openTabs: [pending], workspaces: [], bySession: {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Subject />));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useChatStore.setState(original, true);
  vi.restoreAllMocks();
});

it("locks CLI switching while the first turn is preparing before a native session ID exists", async () => {
  const key = sessionKey(pending.engine, pending.sessionId, pending.workspacePath);
  act(() => useChatStore.setState((state) => ({ bySession: { ...state.bySession, [key]: { ...(state.bySession[key] ?? EMPTY_SESSION), preparing: true } } })));
  expect(entry.engines.find((engine) => engine.engineId === "omp")?.disabled).toBe(true);
  await expect(entry.onSelectEngine("omp")).rejects.toThrow();
  expect(useChatStore.getState().active).toEqual(pending);
});

it("rejects a retained engine callback after another pending conversation becomes active", async () => {
  const selectPreviousConversation = entry.onSelectEngine;
  const next = { ...pending, pendingId: "pending-b" };
  await act(async () => useChatStore.setState({ active: next, openTabs: [next] }));
  await expect(selectPreviousConversation("omp")).rejects.toThrow();
  expect(useChatStore.getState().active).toEqual(next);
});
