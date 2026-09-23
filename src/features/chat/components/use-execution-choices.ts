import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { EngineChoice, ExecutionChoice, ModelEntryProps, PublishedSource } from "@ccgui/plugin-sdk";
import type { ModelOption } from "@/components/application/ai-chat/cli-menu";
import { EFFORT_LEVELS } from "@/components/application/ai-chat/effort-levels";
import { ipc, type EngineCatalog, type EngineInfo } from "@/lib/ipc";
import { listen } from "@/lib/transport";
import { subscribeTauriEvent } from "@/hooks/use-tauri-event";
import { errorText } from "@/lib/errors";
import { PSEUDO_LOCAL } from "@/features/settings/providers";
import { useChatStore, sessionKey, type ActiveSession } from "../store";
import { applyExecutionSelection, contributionTokenPolicy, executionTargetForTab, refreshExecutionSelection, sameModelChoice } from "../store/execution-selection";
import type { EngineOption } from "./engine-options";

export function useExecutionChoices(active: ActiveSession | null, engines: EngineInfo[], catalogs: Record<string, EngineCatalog>, models: Record<string, ModelOption[]>, channels: Record<string, { id: string; label: string }[]>, refreshNative: () => Promise<void>, engineOptions: EngineOption[], selectEngine: (engineId: string) => void) {
  const { t } = useTranslation();
  const key = active ? sessionKey(active.engine, active.sessionId, active.workspacePath) : "";
  const selection = useChatStore((s) => s.bySession[key]?.executionSelection ?? null);
  const unavailableReason = useChatStore((s) => s.bySession[key]?.selectionUnavailableReason ?? undefined);
  const firstTurnBusy = useChatStore((s) => !!(s.bySession[key]?.preparing || s.bySession[key]?.streaming));
  const workspaces = useChatStore((s) => s.workspaces);
  const [sources, setSources] = useState<PublishedSource[]>([]);
  const [loading, setLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string>();
  const target = useMemo(() => active ? executionTargetForTab(active, workspaces) : null, [active, workspaces]);
  const reloadSources = useCallback(async () => {
    try { setSources(await ipc.listCliSources()); setCatalogError(undefined); }
    catch (error) { setCatalogError(errorText(error)); }
  }, []);
  useEffect(() => {
    void reloadSources();
    return subscribeTauriEvent(() => listen("cli://changed", () => { void reloadSources(); }));
  }, [reloadSources]);
  useEffect(() => {
    if (!active) return;
    let current = true;
    setLoading(true);
    void refreshExecutionSelection({ set: useChatStore.setState, get: useChatStore.getState }, active)
      .catch((error) => { if (current) useChatStore.setState({ actionError: errorText(error) }); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [active]);
  const choices = useMemo(() => {
    if (!target) return [];
    const engine = engines.find((item) => item.id === target.engineId);
    const nativeChannels = target.executionTarget.kind === "local" && channels[target.engineId]?.length ? channels[target.engineId] : [{ id: "", label: t("settings.cliOfficial") }];
    const result: ExecutionChoice[] = [];
    for (const channel of nativeChannels) {
      for (const model of [{ id: "", label: t("chat.cliNativeDefault", { defaultValue: "CLI default" }) }, ...(models[target.engineId] ?? [])]) {
        result.push({ choiceId: JSON.stringify(["native", target.engineId, channel.id, model.id]), label: model.label,
          group: channel.id && channel.id !== PSEUDO_LOCAL ? t("chat.legacyChannel", { defaultValue: "Legacy channel: {{name}}", name: channel.label }) : t("settings.cliOfficial"),
          modelSelection: { source: "native", engineId: target.engineId, modelId: model.id || null, channelId: channel.id === PSEUDO_LOCAL ? null : channel.id || null }, credentials: [],
          capabilities: { images: engine?.supportsImages ? "supported" : "unsupported", tools: "unknown", effortLevels: engine?.supportsEffort ? [...EFFORT_LEVELS] : [] },
          tokenPolicy: { contextWindowTokens: catalogs[target.engineId]?.models.find((m) => m.id === model.id)?.contextWindow ?? undefined },
          ...(!engine?.enabled ? { unavailableReason: t("chat.engineUnavailable", { defaultValue: "CLI is disabled" }) } : {}),
        });
      }
    }
    for (const source of sources) for (const choice of source.choices) {
      const profile = source.profiles.find((item) => item.profileKey === choice.profileKey);
      if (!profile || profile.engineId !== target.engineId || profile.executionTarget.kind !== target.executionTarget.kind) continue;
      if (profile.executionTarget.kind === "wsl" && target.executionTarget.kind === "wsl" && (profile.executionTarget.hostId !== target.executionTarget.hostId || profile.executionTarget.distro !== target.executionTarget.distro)) continue;
      result.push({ choiceId: JSON.stringify(["contribution", source.sourceId, choice.profileKey, choice.modelKey]), label: choice.label, group: profile.group || profile.label,
        modelSelection: { source: "contribution", engineId: profile.engineId, sourceId: source.sourceId, profileKey: choice.profileKey, modelKey: choice.modelKey,
          credential: profile.credentials.find((credential) => credential.credentialId === profile.defaultCredentialId) ?? null },
        credentials: profile.credentials, capabilities: choice.capabilities, tokenPolicy: choice.tokenPolicy,
        unavailableReason: !source.available ? source.unavailableReason ?? t("chat.providerUnavailable") : source.unavailableProfiles?.[profile.profileKey],
      });
    }
    if (selection && !result.some((choice) => sameModelChoice(choice.modelSelection, selection.modelSelection))) {
      const model = selection.modelSelection;
      result.push({ choiceId: JSON.stringify(["unavailable", model]), label: model.source === "native" ? model.modelId ?? t("chat.cliNativeDefault") : model.modelKey,
        group: model.source === "native" ? t("settings.cliOfficial") : model.sourceId, modelSelection: model,
        credentials: model.source === "contribution" && model.credential ? [model.credential] : [],
        capabilities: { images: "unknown", tools: "unknown", effortLevels: selection.effort ? [selection.effort] : [] }, tokenPolicy: {},
        unavailableReason: unavailableReason ?? catalogError ?? t("chat.selectedModelUnavailable"),
      });
    }
    return result;
  }, [target, engines, catalogs, models, channels, sources, selection, unavailableReason, catalogError, t]);
  const onApply: ModelEntryProps["onApply"] = useCallback(async (input, expectedVersion) => {
    if (!target) throw new Error("No active conversation");
    return applyExecutionSelection({ set: useChatStore.setState, get: useChatStore.getState }, target, input, expectedVersion);
  }, [target]);
  const onRefresh = useCallback(async () => {
    setLoading(true);
    try {
      await Promise.all([refreshNative(), reloadSources(), active ? refreshExecutionSelection({ set: useChatStore.setState, get: useChatStore.getState }, active) : Promise.resolve()]);
    } finally { setLoading(false); }
  }, [active, refreshNative, reloadSources]);
  // Only a conversation that has not sent its first turn can change CLI:
  // setActiveEngine retargets a pending tab and otherwise just moves the
  // preference, so a started session would silently keep its old engine.
  const started = !!target?.sessionId;
  const engineChoices = useMemo<EngineChoice[]>(() => engineOptions.map((option) => ({
    engineId: option.id, label: option.label, available: option.available,
    disabled: option.disabled || started || firstTurnBusy,
    ...(option.disabled ? { disabledReason: option.disabledReason }
      : started ? { disabledReason: t("chat.engineLockedAfterStart") }
        : firstTurnBusy ? { disabledReason: t("chat.engineSwitchInFlight") } : {}),
  })), [engineOptions, started, firstTurnBusy, t]);
  const onSelectEngine: ModelEntryProps["onSelectEngine"] = useCallback(async (engineId) => {
    const option = engineOptions.find((item) => item.id === engineId);
    if (!option || option.disabled) throw new Error(t("chat.engineUnavailable"));
    const state = useChatStore.getState();
    const selected = state.active;
    if (!target || !selected || selected.engine !== target.engineId || selected.workspacePath !== target.workspacePath
      || selected.sessionId !== target.sessionId || (!target.sessionId && selected.pendingId !== target.pendingId)) {
      throw new Error(t("chat.engineSelectionChanged"));
    }
    if (selected.sessionId) throw new Error(t("chat.engineLockedAfterStart"));
    const session = state.bySession[key];
    if (session?.preparing || session?.streaming) throw new Error(t("chat.engineSwitchInFlight"));
    selectEngine(engineId);
  }, [engineOptions, target, key, selectEngine, t]);
  const tokenPolicy = contributionTokenPolicy(selection?.modelSelection, sources)
    ?? choices.find((choice) => selection && sameModelChoice(choice.modelSelection, selection.modelSelection))?.tokenPolicy;
  return { entryProps: target ? { context: { target, selection, unavailableReason: unavailableReason ?? catalogError }, choices, engines: engineChoices, loading, onApply, onSelectEngine, onRefresh } satisfies ModelEntryProps : null, tokenPolicy };
}
