import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState } from "react";
import Check from "lucide-react/dist/esm/icons/check";
import PanelRightClose from "lucide-react/dist/esm/icons/panel-right-close";
import PanelRightOpen from "lucide-react/dist/esm/icons/panel-right-open";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import { PillTab, PillTabList } from "@/components/base/tabs/pill-tab";
import { HeaderOpenActions } from "@/features/open-app/HeaderOpenActions";
import { LaunchScriptActions } from "@/features/launch-script/LaunchScriptActions";
import { useFilesStore } from "@/features/files/store";
import { cx } from "@/utils/cx";
import { PANEL_TOGGLE_CLASSES } from "./panel-toggle-classes";
import { resolveActivePanelTab, useSortedPanelTabs } from "./panel-tabs";

/** Tab-strip actions slot: the open-in-app cluster plus the side panel's
 * titlebar header (files/changes pills and collapse toggles). */
export function ChatPanelHeader({
  workspacePath,
  panelTab,
  onPanelTabChange,
  panelCollapsed,
  onTogglePanelCollapsed,
  panelWidth,
  panelHeaderRef,
  dragging,
}: {
  workspacePath: string;
  panelTab: string;
  onPanelTabChange: (tab: string) => void;
  panelCollapsed: boolean;
  onTogglePanelCollapsed: () => void;
  panelWidth: number;
  panelHeaderRef: React.RefObject<HTMLDivElement>;
  dragging: "sidebar" | "panel" | null;
}) {
  const { t } = useTranslation();
  const treeRefreshing = useFilesStore((s) => s.refreshing);
  // Builtin tabs (files/changes) register at module scope in ./panel-tabs;
  // plugin tabs arrive via ctx.ui.registerPanelTab (plan §4.2 #4).
  const panelTabs = useSortedPanelTabs();
  // Persisted tab may point at an unloaded plugin tab; fall back to the
  // first tab (read-side only, see resolveActivePanelTab).
  const activeTab = resolveActivePanelTab(panelTabs, panelTab);
  // Success flash: when a refresh finishes, swap the icon to a green check
  // for a beat (same pattern as the copy buttons' "copied" state).
  const [refreshed, setRefreshed] = useState(false);
  const wasRefreshing = useRef(false);
  useEffect(() => {
    if (treeRefreshing) {
      wasRefreshing.current = true;
      return;
    }
    if (!wasRefreshing.current) return;
    wasRefreshing.current = false;
    setRefreshed(true);
    const timer = setTimeout(() => setRefreshed(false), 1000);
    return () => clearTimeout(timer);
  }, [treeRefreshing]);
  // One toggle for both directions; labels/icons follow the collapsed state.
  const toggleLabel = t(
    panelCollapsed ? "openApp.expandPanel" : "openApp.collapsePanel",
  );
  return (
    <div className="flex h-full items-center">
      <LaunchScriptActions workspacePath={workspacePath} />
      <HeaderOpenActions workspacePath={workspacePath} />
      {
        // Deliberately outside the xl-gated chrome below: that wrapper is
        // display:none on narrow windows, and the toggle used to vanish with
        // it, leaving no way to bring the panel back without resizing the
        // window. Rendered before the chrome so the chrome keeps its
        // flush-right edge and its border stays continuous with the panel's.
      }
      <button
        type="button"
        title={toggleLabel}
        aria-label={toggleLabel}
        onClick={onTogglePanelCollapsed}
        className={cx(PANEL_TOGGLE_CLASSES, "mx-1.5")}
      >
        {panelCollapsed ? (
          <PanelRightOpen className="size-4" aria-hidden />
        ) : (
          <PanelRightClose className="size-4" aria-hidden />
        )}
      </button>
      {
        // Panel chrome (tab pills + refresh) lives in the titlebar: same
        // width as the panel below, border-l continuing the panel's left
        // edge. Always mounted so width animates in sync with the panel;
        // stays put in changes mode so its pills remain reachable.
      }
      <div className="hidden h-full items-center xl:flex">
        <div
          ref={panelHeaderRef}
          className={cx(
            "flex h-full items-center justify-end overflow-hidden",
            // Width is mutated imperatively during panel drags.
            !dragging &&
              "transition-[width] duration-200 ease-out motion-reduce:transition-none",
            !panelCollapsed && "border-l border-separator-border",
          )}
          style={{ width: panelCollapsed ? 0 : panelWidth }}
        >
          <div
            className="flex h-full shrink-0 items-center gap-2 px-3"
            style={{ width: panelWidth }}
          >
            <PillTabList>
              {panelTabs.map((tab) => (
                <PillTab
                  key={tab.id}
                  icon={tab.icon}
                  isSelected={activeTab === tab.id}
                  onSelect={() => onPanelTabChange(tab.id)}
                >
                  {tab.label()}
                </PillTab>
              ))}
            </PillTabList>
            {activeTab === "files" && (
              <button
                type="button"
                title={t("common.refresh")}
                aria-label={t("common.refresh")}
                disabled={treeRefreshing}
                onClick={() => void useFilesStore.getState().refreshTree()}
                className={cx(PANEL_TOGGLE_CLASSES, "disabled:opacity-50")}
              >
                {refreshed ? (
                  <Check
                    className="size-4 text-notification-success-foreground"
                    aria-hidden
                  />
                ) : (
                  <RefreshCw
                    className={cx("size-4", treeRefreshing && "animate-spin")}
                    aria-hidden
                  />
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
