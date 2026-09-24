import { useSyncExternalStore } from "react";
import { create } from "zustand";
import { ipc, type PluginInfo } from "@/lib/ipc";
import { listenPluginInstallProgress } from "@/lib/events";
import { pickDirectory } from "@/lib/platform";
import {
  bootstrapPlugins,
  getPluginStatesSnapshot,
  ipcBackend,
  loadPlugin,
  pluginsBootstrapped,
  prunePluginRuntimeState,
  reloadPlugin,
  subscribePluginStates,
  unloadPlugin,
} from "../runtime/loader";
import i18n from "@/lib/i18n";
import { BUILTIN_PLUGINS } from "../builtin";

/** Live runtime states (loading/active/failed/quarantined/…) for the manager UI. */
export function usePluginStates() {
  return useSyncExternalStore(subscribePluginStates, getPluginStatesSnapshot);
}

interface PluginsStore {
  installed: PluginInfo[];
  loaded: boolean;
  error: string | null;
  /** Non-null while an install copy runs; done/total are bytes (total 0 = measuring). */
  installing: { done: number; total: number } | null;
  refresh: () => Promise<void>;
  installFromDirectory: () => Promise<void>;
  setEnabled: (plugin: PluginInfo, enabled: boolean) => Promise<void>;
  /** Clear a quarantine/failure and load the plugin again, in place. */
  retry: (plugin: PluginInfo) => Promise<void>;
  uninstall: (plugin: PluginInfo, deleteData: boolean) => Promise<void>;
}

/** Builtin metadata merged into the manager list: a builtin's state record
 *  (created by enable/quarantine upserts) carries no manifest fields, so the
 *  builtin's own info wins the display fields while the record wins state
 *  (enabled/quarantined/lastError). One row per id. */
function withBuiltins(installed: PluginInfo[]): PluginInfo[] {
  const builtinById: Record<string, PluginInfo> = {};
  for (const b of BUILTIN_PLUGINS) builtinById[b.info.id] = b.info;
  const seen: Record<string, true> = {};
  const merged = installed.flatMap((record) => {
    const builtin = builtinById[record.id];
    // State-only leftovers of a since-removed builtin (no directory, no
    // manifest fields) must not surface as ghost rows.
    if (!builtin && record.source === "builtin" && record.version === "") return [];
    if (!builtin) return [record];
    seen[record.id] = true;
    return {
      ...builtin,
      enabled: record.enabled,
      quarantined: record.quarantined,
      lastError: record.lastError,
      installedAt: record.installedAt,
    };
  });
  for (const builtin of BUILTIN_PLUGINS) {
    if (!seen[builtin.info.id]) merged.push(builtin.info);
  }
  return merged;
}

/** Builtins carry no manifest fields in their backend record, so the loader
 *  needs the in-tree manifest/activate pair when the id matches one. */
function loadableFor(plugin: PluginInfo, info: PluginInfo) {
  const builtin = BUILTIN_PLUGINS.find((b) => b.info.id === plugin.id);
  return { info, manifest: builtin?.manifest, builtinActivate: builtin?.builtinActivate };
}

export const usePluginsStore = create<PluginsStore>((set, get) => ({
  installed: [],
  loaded: false,
  error: null,
  installing: null,

  refresh: async () => {
    try {
      // Self-heal: if the startup bootstrap gave up (backend lost the
      // startup race), opening 插件管理 re-runs it so enabled plugins
      // activate instead of only showing a persisted "on" switch.
      if (!pluginsBootstrapped()) {
        await bootstrapPlugins(ipcBackend, BUILTIN_PLUGINS).catch(() => {});
      }
      set({ installed: withBuiltins(await ipc.pluginList()), loaded: true, error: null });
    } catch (error) {
      set({ error: String(error), loaded: true });
    }
  },

  installFromDirectory: async () => {
    const path = await pickDirectory(i18n.t("plugins.installPickTitle"));
    if (!path) return;
    set({ installing: { done: 0, total: 0 } });
    const unlisten = await listenPluginInstallProgress((p) => {
      set({ installing: { done: p.done, total: p.total } });
    });
    try {
      const info = await ipc.pluginInstallFromPath(path);
      // reloadPlugin, not loadPlugin: installing from a directory over an
      // existing id is an update of a possibly-running plugin, and loadPlugin
      // early-returns for an already-active id (the user then kept the old
      // code until an app restart).
      if (info.enabled) await reloadPlugin({ info });
      await get().refresh();
    } catch (error) {
      set({ error: String(error) });
    } finally {
      unlisten();
      set({ installing: null });
    }
  },

  setEnabled: async (plugin, enabled) => {
    try {
      const info = await ipc.pluginSetEnabled(plugin.id, enabled);
      if (enabled) {
        await loadPlugin(loadableFor(plugin, info));
      } else {
        unloadPlugin(plugin.id);
      }
      await get().refresh();
    } catch (error) {
      set({ error: String(error) });
    }
  },

  retry: async (plugin) => {
    try {
      // `plugin_set_enabled(true)` is the backend's "trust it again" upsert:
      // it clears quarantined + lastError, which is what the loader's sticky
      // skip keys off. Same recovery as toggling the switch off→on, without
      // showing a misleading disabled state in between.
      const info = await ipc.pluginSetEnabled(plugin.id, true);
      await reloadPlugin(loadableFor(plugin, info));
      await get().refresh();
    } catch (error) {
      set({ error: String(error) });
    }
  },

  uninstall: async (plugin, deleteData) => {
    try {
      unloadPlugin(plugin.id);
      await ipc.pluginUninstall(plugin.id, deleteData);
      prunePluginRuntimeState(plugin.id);
      await get().refresh();
    } catch (error) {
      set({ error: String(error) });
    }
  },
}));
