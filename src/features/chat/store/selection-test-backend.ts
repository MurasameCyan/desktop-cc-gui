import { beforeEach, vi } from "vitest";
import type { ExecutionSelectionInput, SessionExecutionContext, SessionExecutionTarget } from "@ccgui/plugin-sdk";

/** Stateful IPC stand-in for frontend races: CAS and session isolation match
 * the public backend contract; no credentials or global defaults are inferred. */
export function createSelectionBackend() {
  const records = new Map<string, SessionExecutionContext>();
  beforeEach(() => records.clear());
  const key = (target: SessionExecutionTarget) => JSON.stringify(target);
  return {
    getSessionSelection: vi.fn(async (target: SessionExecutionTarget): Promise<SessionExecutionContext> => records.get(key(target)) ?? {
      target, selection: target.sessionId ? { version: 1, modelSelection: { source: "native", engineId: target.engineId, modelId: null, channelId: null }, effort: null } : null,
    }),
    setSessionSelection: vi.fn(async (target: SessionExecutionTarget, input: ExecutionSelectionInput, expectedVersion: number | null): Promise<SessionExecutionContext> => {
      const previous = records.get(key(target));
      if (previous && previous.selection?.version !== expectedVersion) throw new Error("stale selection version");
      const context = { target, selection: { ...input, version: (expectedVersion ?? 0) + 1 } };
      records.set(key(target), context);
      return context;
    }),
    listCliSources: vi.fn(async () => []),
  };
}
