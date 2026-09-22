import { ipc } from "@/lib/ipc";
import { errorText } from "@/lib/errors";
import { writeStored } from "@/lib/storage";
import {
  PERMISSION_PREF_KEY,
} from "./persistence";
import { persistSettings } from "./settings-persist";
import type { ChatStore } from "./types";
import type { StoreGet, StoreSet } from "./context";
import { applyExecutionSelection, refreshExecutionSelection } from "./execution-selection";
import type { ExecutionSelectionInput } from "@ccgui/plugin-sdk";
import { PSEUDO_LOCAL } from "@/features/settings/providers";

/**
 * Preference actions: composer permission, service tiers, per-engine
 * model/effort/provider picks, and the small settings-backed toggles
 * (thread limit, send shortcut, thinking auto-collapse).
 */

export interface PreferenceDeps {
  set: StoreSet;
  get: StoreGet;
}

export function createPreferenceActions(
  deps: PreferenceDeps,
): Pick<
  ChatStore,
  | "setPermission"
  | "setOmpServiceTier"
  | "setCodexServiceTier"
  | "setEffort"
  | "setModel"
  | "setProvider"
  | "pinModels"
  | "setThreadLimit"
  | "setSendShortcut"
  | "setThinkingAutoCollapse"
> {
  const { set, get } = deps;

  async function updateSelection(engine: string, change: (selection: ExecutionSelectionInput) => ExecutionSelectionInput) {
    const tab = get().active;
    if (!tab || tab.engine !== engine) return;
    try {
      const context = await refreshExecutionSelection({ set, get }, tab);
      const current = context.selection ?? { modelSelection: { source: "native" as const, engineId: engine, modelId: null, channelId: null }, effort: null };
      await applyExecutionSelection({ set, get }, context.target, change(current), context.selection?.version ?? null);
    } catch (error) {
      set({ actionError: errorText(error) });
    }
  }

  return {
    setPermission: (permission) => {
      writeStored(PERMISSION_PREF_KEY, permission);
      set({ permission });
    },
    setOmpServiceTier: async (tier) => {
      const settings = await ipc.getAppSettings();
      await ipc.updateAppSettings({ ...settings, ompOpenaiServiceTier: tier });
      set({ ompServiceTier: tier });
    },
    setCodexServiceTier: async (tier) => {
      const settings = await ipc.getAppSettings();
      await ipc.updateAppSettings({ ...settings, codexServiceTier: tier });
      set({ codexServiceTier: tier });
    },
    setEffort: (engine, effort) => updateSelection(engine, (selection) => ({ modelSelection: selection.modelSelection, effort })),
    setModel: (engine, model) => updateSelection(engine, (selection) => ({
      modelSelection: { source: "native", engineId: engine, modelId: model || null,
        channelId: selection.modelSelection.source === "native" ? selection.modelSelection.channelId : null },
      effort: selection.effort,
    })),
    setProvider: (engine, providerId) => updateSelection(engine, (selection) => ({
      modelSelection: { source: "native", engineId: engine,
        modelId: selection.modelSelection.source === "native" ? selection.modelSelection.modelId : null,
        channelId: providerId === PSEUDO_LOCAL ? null : providerId || null },
      effort: selection.effort,
    })),
    pinModels: async (updates, persist = true) => {
      const entries = Object.entries(updates).filter(([, model]) =>
        model.trim(),
      );
      if (entries.length === 0) return;
      const models = { ...get().models };
      for (const [engine, model] of entries) models[engine] = model;
      set({ models });
      if (!persist) return;
      await persistSettings((settings) => ({
        defaultModels: {
          ...settings.defaultModels,
          ...Object.fromEntries(entries),
        },
      }));
    },

    setThreadLimit: (limit) => {
      set({ threadLimit: Math.max(1, Math.floor(limit)) });
    },

    setSendShortcut: (shortcut) => {
      set({ sendShortcut: shortcut });
    },
    setThinkingAutoCollapse: (autoCollapse) => {
      set({ thinkingAutoCollapse: autoCollapse });
    },
  };
}
