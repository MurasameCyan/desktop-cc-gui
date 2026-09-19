import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import FolderInput from "lucide-react/dist/esm/icons/folder-input";
import Loader2 from "lucide-react/dist/esm/icons/loader-2";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import { Switch } from "@/components/base/switch/switch";
import { DisplayName } from "@/components/base/display-name";
import { isWeb } from "@/lib/platform";
import {
  SettingsCard,
  SettingsRow,
  SettingsSectionLabel,
} from "@/components/application/settings/settings-rows";
import { cx } from "@/utils/cx";
import { ConfirmDialog } from "@/components/dialogs";
import type { PluginInfo } from "@/lib/ipc";
import { SDK_VERSION } from "@ccgui/plugin-sdk";
import { usePluginsStore, usePluginStates } from "./usePlugins";
import { useMarketplaceStore } from "../marketplace/store";
import { reloadPlugin, type PluginRuntimeState } from "../runtime/loader";
import { compatSdkEnabled, setCompatSdkEnabled } from "../runtime/sdk-compat";

const BADGE =
  "rounded-md bg-background-secondary-default px-1.5 py-0.5 text-xs text-text-secondary";

/** Runtime states that get an error badge on the row; installed/loading/
 *  active are healthy and need no label. */
const STATE_LABELS: Partial<Record<PluginRuntimeState, string>> = {
  failed: "plugins.stateFailed",
  quarantined: "plugins.stateQuarantined",
  incompatible: "plugins.stateIncompatible",
};

/** One-click update to the marketplace version; renders nothing when the
 *  index has nothing newer for this plugin. */
function UpdateButton({ plugin }: { plugin: PluginInfo }) {
  const { t } = useTranslation();
  const update = useMarketplaceStore((s) => s.updates.find((u) => u.id === plugin.id));
  const installing = useMarketplaceStore((s) => s.installing);
  const installUpdate = useMarketplaceStore((s) => s.install);

  if (!update) return null;
  return (
    <button
      type="button"
      disabled={!!installing || isWeb}
      title={isWeb ? t("plugins.market.desktopOnly") : undefined}
      onClick={() => void installUpdate(plugin.id)}
      className="flex cursor-pointer items-center gap-1 rounded-lg bg-background-secondary-default whitespace-nowrap px-2.5 py-1.5 text-body-medium text-text-primary transition-colors hover:bg-background-secondary-hover disabled:cursor-not-allowed disabled:opacity-60"
    >
      {installing?.id === plugin.id ? (
        <Loader2 className="size-4 animate-spin" aria-hidden />
      ) : (
        t("plugins.market.updateTo", { version: update.latestVersion })
      )}
    </button>
  );
}

/** Uninstall behind a real modal: window.confirm is unreliable in Tauri's
 *  WKWebView (no JS confirm-panel delegate — it can return a non-boolean,
 *  which the backend rejects as "invalid type: map, expected a boolean").
 *  Saved plugin data is never wiped on uninstall: deleteData stays false and
 *  the KV rows ride the 30-day tombstone purge instead. Builtins cannot be
 *  uninstalled, so they get no button. */
function UninstallButton({ plugin }: { plugin: PluginInfo }) {
  const { t } = useTranslation();
  const uninstall = usePluginsStore((s) => s.uninstall);
  const [confirming, setConfirming] = useState(false);

  if (plugin.source === "builtin") return null;
  return (
    <>
      <button
        type="button"
        aria-label={t("plugins.uninstall")}
        onClick={() => setConfirming(true)}
        className="cursor-pointer rounded-lg p-1.5 text-foreground-icon-secondary transition-colors hover:bg-background-primary-hover hover:text-foreground-icon-primary"
      >
        <Trash2 className="size-4" aria-hidden />
      </button>
      {confirming && (
        <ConfirmDialog
          danger
          message={t("plugins.uninstallConfirm", { name: plugin.name })}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            void uninstall(plugin, false);
          }}
        />
      )}
    </>
  );
}

function PluginRow({ plugin }: { plugin: PluginInfo }) {
  const { t } = useTranslation();
  const states = usePluginStates();
  const setEnabled = usePluginsStore((s) => s.setEnabled);
  const runtime = states.find((s) => s.id === plugin.id);
  const stateLabel = runtime ? STATE_LABELS[runtime.state] : undefined;
  const errorText = runtime?.error ?? plugin.lastError;

  return (
    <div className="flex flex-col gap-1 px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2">
            <span className="truncate text-body-medium text-text-primary">
              <DisplayName name={plugin.name} />
            </span>
            <span className={BADGE}>v{plugin.version}</span>
            <span className={BADGE}>{plugin.tier === "declarative" ? "Tier-0" : "JS"}</span>
            <span className={BADGE}>
              {t(`plugins.source.${plugin.source}`, plugin.source)}
            </span>
            {stateLabel && (
              <span className={cx(BADGE, "text-text-error-primary")}>
                {t(stateLabel)}
              </span>
            )}
            {runtime?.compat && (
              <span
                className={cx(BADGE, "text-text-warning-primary")}
                title={t("plugins.compatBadgeHint", {
                  range: runtime.compat,
                  host: SDK_VERSION,
                })}
              >
                {t("plugins.stateCompat")}
              </span>
            )}
          </div>
          {plugin.description && (
            <span className="truncate text-body-medium text-text-secondary">
              {plugin.description}
            </span>
          )}
          {errorText && (
            <span className="truncate text-body-medium text-text-error-primary">{errorText}</span>
          )}
        </div>
        <Switch
          size="sm"
          aria-label={plugin.name}
          isSelected={plugin.enabled}
          onChange={(next) => void setEnabled(plugin, next)}
        />
        <UpdateButton plugin={plugin} />
        <UninstallButton plugin={plugin} />
      </div>
    </div>
  );
}

/** 插件管理 settings section (plan §7 Phase 1 item 5): installed list,
 *  enable/disable, uninstall, install-from-directory. Marketplace browsing
 *  is Phase 3. */
export default function PluginsSection() {
  const { t } = useTranslation();
  const { installed, loaded, error, installing, refresh, installFromDirectory } =
    usePluginsStore();
  const states = usePluginStates();
  const [compatSdk, setCompatSdk] = useState(compatSdkEnabled);

  useEffect(() => {
    void refresh();
    // Update badges on marketplace rows ride the same 1h index cache; a
    // failed check just leaves the list empty, so fire and forget.
    void useMarketplaceStore.getState().checkUpdates();
  }, [refresh]);

  // Flipping the switch re-runs the handshake for exactly the plugins the
  // policy decides on: the refused ones when enabling, the compat-loaded ones
  // when disabling. Everything else keeps running untouched.
  const toggleCompatSdk = (next: boolean) => {
    setCompatSdk(next);
    setCompatSdkEnabled(next);
    for (const entry of states) {
      const affected = next ? entry.state === "incompatible" : !!entry.compat;
      const plugin = affected && installed.find((p) => p.id === entry.id);
      if (plugin) void reloadPlugin({ info: plugin });
    }
  };

  return (
    <div className="flex w-full flex-col gap-6">
      {error && (
        <div className="rounded-xl bg-background-secondary-default px-4 py-2 text-body-medium text-text-error-primary">
          {error}
        </div>
      )}
      <div className="flex flex-col gap-2">
        <SettingsSectionLabel>{t("plugins.compatLabel")}</SettingsSectionLabel>
        <SettingsCard>
          <SettingsRow label={t("plugins.compatTitle")} description={t("plugins.compatHint")}>
            <Switch
              size="sm"
              aria-label={t("plugins.compatTitle")}
              isSelected={compatSdk}
              onChange={toggleCompatSdk}
            />
          </SettingsRow>
        </SettingsCard>
      </div>
      <div className="flex items-center justify-between">
        <SettingsSectionLabel>{t("plugins.installedLabel")}</SettingsSectionLabel>
        <button
          type="button"
          disabled={!!installing}
          onClick={() => void installFromDirectory()}
          className={cx(
            "flex cursor-pointer items-center gap-1.5 rounded-lg bg-background-secondary-default whitespace-nowrap px-3 py-1.5 text-body-medium text-text-primary transition-colors hover:bg-background-secondary-hover",
            installing && "cursor-wait opacity-70",
          )}
        >
          {installing ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <FolderInput className="size-4" aria-hidden />
          )}
          {installing
            ? installing.total > 0
              ? t("plugins.installingPct", {
                  pct: Math.round((installing.done / installing.total) * 100),
                })
              : t("plugins.installing")
            : t("plugins.installFromDir")}
        </button>
      </div>
      <SettingsCard className="divide-y divide-separator-border">
        {!loaded || installed.length === 0 ? (
          <div className="px-4 py-3 text-body-medium text-text-secondary">
            {loaded ? t("plugins.empty") : t("common.loading")}
          </div>
        ) : (
          installed.map((plugin) => <PluginRow key={plugin.id} plugin={plugin} />)
        )}
      </SettingsCard>
    </div>
  );
}
