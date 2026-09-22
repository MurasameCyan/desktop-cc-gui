import type { ExecutionSelectionInput, ExecutionTarget, ModelSelection, PublishedSource, SessionExecutionContext, SessionExecutionTarget, TokenPolicy } from "@ccgui/plugin-sdk";
import { ipc, type Workspace } from "@/lib/ipc";
import { errorText } from "@/lib/errors";
import { sessionKey, type ActiveSession } from "./persistence";
import { EMPTY_SESSION } from "./stream";
import type { StoreGet, StoreSet } from "./context";
import { PSEUDO_LOCAL } from "@/features/settings/providers";

type SelectionDeps = { get: StoreGet; set: StoreSet };

export function executionTargetForTab(tab: ActiveSession, workspaces: Workspace[]): SessionExecutionTarget {
  const wsl = workspaces.find((w) => w.path === tab.workspacePath)?.meta?.wsl;
  const executionTarget: ExecutionTarget = wsl && typeof wsl === "object" && "hostId" in wsl && "distro" in wsl && typeof wsl.hostId === "string" && typeof wsl.distro === "string"
    ? { kind: "wsl", hostId: wsl.hostId, distro: wsl.distro } : { kind: "local" };
  if (!tab.sessionId && !tab.pendingId) throw new Error("Pending conversation has no selection identity");
  return { engineId: tab.engine, workspacePath: tab.workspacePath, sessionId: tab.sessionId,
    ...(!tab.sessionId ? { pendingId: tab.pendingId } : {}), executionTarget };
}

export function selectionTargetKey(target: SessionExecutionTarget): string {
  return sessionKey(target.engineId, target.sessionId, target.workspacePath);
}

/** Adopt an entire backend record. Never let an older response splice values
 * into a newer selection or touch whichever tab happens to be in front. */
export function adoptExecutionContext({ set }: SelectionDeps, context: SessionExecutionContext): void {
  set((state) => {
    const { target, selection } = context;
    const key = selectionTargetKey(target);
    if (!target.sessionId && !state.openTabs.some((tab) => tab.engine === target.engineId && tab.workspacePath === target.workspacePath && tab.sessionId === null && tab.pendingId === target.pendingId)) return {};
    const current = state.bySession[key] ?? EMPTY_SESSION;
    if (current.executionSelection && (!selection || selection.version < current.executionSelection.version)) return {};
    return { bySession: { ...state.bySession, [key]: { ...current, executionSelection: selection,
      pendingId: target.sessionId ? undefined : target.pendingId,
      selectionUnavailableReason: context.unavailableReason ?? null } } };
  });
}

export async function applyExecutionSelection(deps: SelectionDeps, target: SessionExecutionTarget, input: ExecutionSelectionInput, expectedVersion: number | null): Promise<SessionExecutionContext> {
  try {
    const context = await ipc.setSessionSelection(target, input, expectedVersion);
    adoptExecutionContext(deps, context);
    deps.set({ actionError: null });
    return context;
  } catch (error) {
    deps.set({ actionError: errorText(error) });
    throw error;
  }
}

const initializing = new Map<string, Promise<SessionExecutionContext>>();
/** New tabs seed once; existing conversations are exclusively backend-owned. */
export async function refreshExecutionSelection(deps: SelectionDeps, tab: ActiveSession): Promise<SessionExecutionContext> {
  const target = executionTargetForTab(tab, deps.get().workspaces);
  let context = await ipc.getSessionSelection(target);
  if (!context.selection && !target.sessionId) {
    const id = JSON.stringify(target);
    let pending = initializing.get(id);
    if (!pending) {
      const state = deps.get();
      pending = ipc.setSessionSelection(target, {
        modelSelection: { source: "native", engineId: tab.engine, modelId: target.executionTarget.kind === "local" ? tab.model ?? state.models[tab.engine] ?? null : null,
          channelId: target.executionTarget.kind === "local" ? ((tab.provider ?? state.providers[tab.engine]) === PSEUDO_LOCAL ? null : tab.provider ?? state.providers[tab.engine] ?? null) : null },
        effort: target.executionTarget.kind === "local" ? tab.effort ?? state.efforts[tab.engine] ?? null : null,
      }, null).finally(() => initializing.delete(id));
      initializing.set(id, pending);
    }
    context = await pending;
  }
  adoptExecutionContext(deps, context);
  const latest = deps.get().bySession[selectionTargetKey(context.target)];
  return latest?.executionSelection && latest.executionSelection.version > (context.selection?.version ?? -1)
    ? { target: context.target, selection: latest.executionSelection, unavailableReason: latest.selectionUnavailableReason ?? undefined } : context;
}

export function sameModelChoice(a: ModelSelection, b: ModelSelection): boolean {
  if (a.source !== b.source || a.engineId !== b.engineId) return false;
  return a.source === "native" && b.source === "native"
    ? a.modelId === b.modelId && (a.channelId ?? null) === (b.channelId ?? null)
    : a.source === "contribution" && b.source === "contribution" && a.sourceId === b.sourceId && a.profileKey === b.profileKey && a.modelKey === b.modelKey;
}

export function contributionModelId(selection: ModelSelection, sources: PublishedSource[]): string | null {
  if (selection.source === "native") return selection.modelId;
  const choice = sources.find((s) => s.sourceId === selection.sourceId)?.choices.find((c) => c.profileKey === selection.profileKey && c.modelKey === selection.modelKey);
  return choice ? (choice.selector.kind === "alias" ? choice.selector.alias : choice.selector.modelId) : null;
}

export function contributionTokenPolicy(selection: ModelSelection | undefined, sources: PublishedSource[]): TokenPolicy | undefined {
  if (selection?.source !== "contribution") return undefined;
  return sources.find((s) => s.sourceId === selection.sourceId)?.choices.find((c) => c.profileKey === selection.profileKey && c.modelKey === selection.modelKey)?.tokenPolicy;
}
