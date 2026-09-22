import type { ExecutionSelectionInput, SessionExecutionContext, SessionExecutionTarget } from "@ccgui/plugin-sdk";
import { useChatStore } from "@/features/chat/store";
import { applyExecutionSelection, executionTargetForTab, refreshExecutionSelection } from "@/features/chat/store/execution-selection";

export async function getPluginSessionContext(): Promise<SessionExecutionContext | null> {
  const active = useChatStore.getState().active;
  return active ? refreshExecutionSelection({ set: useChatStore.setState, get: useChatStore.getState }, active) : null;
}

export function setPluginSessionSelection(target: SessionExecutionTarget, input: ExecutionSelectionInput, expectedVersion: number | null): Promise<SessionExecutionContext> {
  return applyExecutionSelection({ set: useChatStore.setState, get: useChatStore.getState }, target, input, expectedVersion);
}

export async function setPluginSessionEffort(engine: string, sessionId: string, workspacePath: string, effort: string): Promise<void> {
  const trimmed = effort.trim();
  if (!trimmed) throw new Error("sessions.setEffort: effort must be non-empty");
  if (!engine || !sessionId) throw new Error("sessions.setEffort: engine and sessionId are required");
  const state = useChatStore.getState();
  const tab = state.openTabs.find((t) => t.engine === engine && t.sessionId === sessionId && t.workspacePath === workspacePath)
    ?? state.sessions.find((t) => t.engine === engine && t.sessionId === sessionId && t.workspacePath === workspacePath);
  if (!tab) throw new Error("sessions.setEffort: unknown session");
  const context = await refreshExecutionSelection({ set: useChatStore.setState, get: useChatStore.getState }, tab);
  if (!context.selection) throw new Error("Session has no execution selection");
  await setPluginSessionSelection(executionTargetForTab(tab, state.workspaces), {
    modelSelection: context.selection.modelSelection, effort: trimmed,
  }, context.selection.version);
}
