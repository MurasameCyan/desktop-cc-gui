import { useMemo } from "react";
import { EFFORT_LEVELS, type EffortLevel } from "@/components/application/ai-chat/effort-levels";
import { useChatStore, type ActiveSession } from "../store";

/** Session records and history rows carry plain strings; anything that is not
 *  one of the picker's stops (a hand-edited settings file, an engine that
 *  reports its own vocabulary) is ignored instead of shown as a level. */
function asEffortLevel(value: string | null | undefined): EffortLevel | undefined {
  return value && (EFFORT_LEVELS as readonly string[]).includes(value)
    ? (value as EffortLevel)
    : undefined;
}

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
  const sessionActiveEffort = useChatStore((s) =>
    sessionKey ? (s.bySession[sessionKey]?.activeEffort ?? null) : null,
  );
  const sessionHistoryEffort = useChatStore((s) => {
    if (!sessionKey) return null;
    const messages = s.bySession[sessionKey]?.messages;
    if (!messages) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const effort = messages[i].effort;
      if (effort) return effort;
    }
    return null;
  });
  const tabEffort = useMemo(() => {
    if (!active || active.engine !== activeEngine) return undefined;
    // Same chain as the model: this tab's pick, then what the session ran,
    // then the level its history was written with, then the engine default.
    // Without the middle levels a reopened session showed (and sent) the
    // engine default instead of the level that conversation uses.
    return (
      active.effort ||
      asEffortLevel(sessionActiveEffort) ||
      asEffortLevel(sessionHistoryEffort) ||
      efforts[activeEngine]
    );
  }, [
    active,
    activeEngine,
    sessionActiveEffort,
    sessionHistoryEffort,
    efforts,
  ]);
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
