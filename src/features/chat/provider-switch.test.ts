import { beforeEach, expect, it, vi } from "vitest";
import type { SessionExecutionContext } from "@ccgui/plugin-sdk";
import { ipc } from "@/lib/ipc";
import { useChatStore } from "./store";
import { EMPTY_SESSION } from "./store/stream";

vi.mock("@/lib/ipc", () => ({ ipc: { getSessionSelection: vi.fn(), setSessionSelection: vi.fn() } }));
const tab = { engine: "codex", sessionId: "a", workspacePath: "/ws" };
const context: SessionExecutionContext = { target: { engineId: "codex", sessionId: "a", workspacePath: "/ws", executionTarget: { kind: "local" } },
  selection: { version: 2, modelSelection: { source: "native", engineId: "codex", modelId: "model-a", channelId: "old" }, effort: "high" } };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(ipc.getSessionSelection).mockResolvedValue(context);
  useChatStore.setState({ active: tab, openTabs: [tab], workspaces: [], bySession: { "codex/a": { ...EMPTY_SESSION, executionSelection: context.selection } }, providers: { codex: "default" }, actionError: null });
});
it("preserves the whole old record when a channel switch loses its CAS race", async () => {
  vi.mocked(ipc.setSessionSelection).mockRejectedValueOnce("stale selection version");
  await useChatStore.getState().setProvider("codex", "new");
  expect(useChatStore.getState().bySession["codex/a"].executionSelection).toEqual(context.selection);
  expect(useChatStore.getState().actionError).toBe("stale selection version");
});
it("does not retarget a delayed successful switch to the foreground tab", async () => {
  const gate = Promise.withResolvers<SessionExecutionContext>();
  vi.mocked(ipc.setSessionSelection).mockReturnValueOnce(gate.promise);
  const pending = useChatStore.getState().setProvider("codex", "new");
  await vi.waitFor(() => expect(ipc.setSessionSelection).toHaveBeenCalled());
  const other = { ...tab, sessionId: "b" };
  useChatStore.setState({ active: other, openTabs: [tab, other] });
  gate.resolve({ ...context, selection: { version: 3, modelSelection: { source: "native", engineId: "codex", modelId: "model-a", channelId: "new" }, effort: "high" } });
  await pending;
  expect(useChatStore.getState().providers.codex).toBe("default");
  expect(useChatStore.getState().active).toBe(other);
  expect(useChatStore.getState().bySession["codex/a"].executionSelection?.modelSelection).toMatchObject({ channelId: "new", modelId: "model-a" });
  expect(useChatStore.getState().bySession["codex/b"]).toBeUndefined();
});
