import { bootstrapPlugins, ipcBackend } from "./runtime/loader";
import { BUILTIN_PLUGINS } from "./builtin";
import { usePluginsStore } from "./manager/usePlugins";
import { useMarketplaceStore } from "./marketplace/store";

let started = false;

/**
 * Plugin system entry (plan §4.1): bootstraps the loader — hardening,
 * usage-event bridge, builtin + installed plugins. Called once from App on
 * mount; idempotent.
 *
 * 插件管理 / 插件市场 no longer register as settings sections: both live in
 * the native plugin hub center tab (sidebar 插件 entry), while the settings
 * 插件 group keeps just the sections plugins register themselves.
 */
export function startPluginSystem(): void {
  if (started) return;
  started = true;
  void bootstrapWithRetry()
    .then(() => usePluginsStore.getState().refresh())
    // Update hints (plan ADR-4): check at startup and once every 24h.
    .then(() => {
      const check = () => void useMarketplaceStore.getState().checkUpdates();
      check();
      setInterval(check, 24 * 3600 * 1000);
    })
    .catch((error) => console.error("[plugins] bootstrap failed", error));
}

/** Backend list can lose the startup race (DB/bridge not ready when App
 *  mounts). Retry with backoff; if every attempt fails the plugins store
 *  re-kicks bootstrap when the hub asks for the installed list
 *  (pluginsBootstrapped gate). */
const BOOTSTRAP_RETRY_DELAYS_MS = [2000, 5000, 10_000];

async function bootstrapWithRetry(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await bootstrapPlugins(ipcBackend, BUILTIN_PLUGINS);
      return;
    } catch (error) {
      const delay = BOOTSTRAP_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) throw error;
      console.warn(
        `[plugins] bootstrap attempt ${attempt + 1} failed; retrying in ${delay}ms`,
        error,
      );
      // Not Promise.withResolvers: that is Chromium 119+, and a WebView2 that
      // still lacks it throws inside this catch, which skips every later retry
      // and leaves plugins unloaded until the hub is opened.
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
