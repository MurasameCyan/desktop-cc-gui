import { useMemo } from "react";
import { EFFORT_LEVELS, type EffortLevel } from "@/components/application/ai-chat/effort-levels";
import { PSEUDO_LOCAL } from "@/features/settings/providers";
import { useChatStore, type ActiveSession } from "../store";

/** Foreground display is derived from one versioned backend record. Historical
 * run stamps and global preferences never override an established selection. */
export function useTabModelDisplay({ active, activeEngine, sessionKey, models, efforts, providers }: {
  active: ActiveSession | null; activeEngine: string; sessionKey: string;
  models: Record<string, string>; efforts: Record<string, EffortLevel>; providers: Record<string, string>;
}) {
  const selection = useChatStore((s) => s.bySession[sessionKey]?.executionSelection ?? null);
  return useMemo(() => {
    if (!active || active.engine !== activeEngine) return { displayModels: models, displayEfforts: efforts, displayProviders: providers };
    const model = selection?.modelSelection;
    const displayModels = { ...models, [activeEngine]: model?.source === "native" ? model.modelId ?? "" : model?.modelKey ?? "" };
    const displayEfforts = { ...efforts };
    delete displayEfforts[activeEngine];
    if (selection?.effort && (EFFORT_LEVELS as readonly string[]).includes(selection.effort)) displayEfforts[activeEngine] = selection.effort as EffortLevel;
    const displayProviders = { ...providers, [activeEngine]: model?.source === "native" ? model.channelId ?? PSEUDO_LOCAL : PSEUDO_LOCAL };
    return { displayModels, displayEfforts, displayProviders };
  }, [active, activeEngine, selection, models, efforts, providers]);
}
