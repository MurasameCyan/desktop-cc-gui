import { useMemo } from "react";
import type { EffortLevel } from "@/components/application/ai-chat/cli-menu";
import { useChatStore, type ActiveSession } from "../store";

/** Model/effort the composer menus show for the active tab.
 *
 * The picker follows the SESSION, not the CLI: an explicit pick for this
 * tab, else the model this session actually ran, else the engine default.
 * Two omp sessions in one project therefore show their own models and do
 * not change under each other when the user switches tabs.
 *
 * Subscribed as two narrow slices (strings, Object.is-compared) instead of
 * the bySession record: stream flushes swap that record every frame, and
 * the composer must not re-render with it (SessionTimeline owns that). */
export function useTabModelDisplay({
  active,
  activeEngine,
  sessionKey,
  models,
  efforts,
}: {
  active: ActiveSession | null;
  activeEngine: string;
  sessionKey: string;
  models: Record<string, string>;
  efforts: Record<string, EffortLevel>;
}) {
  const sessionActiveModel = useChatStore((s) =>
    sessionKey ? (s.bySession[sessionKey]?.activeModel ?? null) : null,
  );
  const sessionHistoryModel = useChatStore((s) => {
    if (!sessionKey) return null;
    const messages = s.bySession[sessionKey]?.messages;
    if (!messages) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const model = messages[i].model;
      if (model) return model;
    }
    return null;
  });
  const tabModel = useMemo(() => {
    if (!active || active.engine !== activeEngine) return undefined;
    // tab pick → what the engine reported running → this session's history
    // → the engine default for a session with nothing recorded yet.
    return (
      active.model ||
      sessionActiveModel ||
      sessionHistoryModel ||
      models[activeEngine]
    );
  }, [active, activeEngine, sessionActiveModel, sessionHistoryModel, models]);
  const tabEffort =
    active && active.engine === activeEngine ? active.effort : undefined;
  const displayModels = useMemo(
    () =>
      tabModel !== undefined ? { ...models, [activeEngine]: tabModel } : models,
    [tabModel, models, activeEngine],
  );
  const displayEfforts = useMemo(
    () =>
      tabEffort !== undefined
        ? { ...efforts, [activeEngine]: tabEffort }
        : efforts,
    [tabEffort, efforts, activeEngine],
  );
  return { displayModels, displayEfforts };
}
