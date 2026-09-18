import Plus from "lucide-react/dist/esm/icons/plus";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReactNode } from "react";
import { needsWindowControls, useTitlebarStyle } from "@/features/settings/titlebar";
import { WindowControls } from "@/components/application/window-controls";
import { cx } from "@/utils/cx";
import { SessionTab, type SessionTabItem } from "./SessionTab";
import { useTabDragReorder } from "./use-tab-drag-reorder";
import { useTabStripChrome } from "./use-tab-strip-chrome";
import { TabStripContextMenu } from "./TabStripContextMenu";

export type { SessionTabItem };

// Overlay titlebar leaves the native traffic lights floating over the
// strip's left edge on macOS; other platforms keep their own titlebar.
const IS_MAC =
  typeof navigator !== "undefined" && /macintosh|mac os x/i.test(navigator.userAgent);

interface SessionTabStripProps {
  tabs: SessionTabItem[];
  activeKey: string | null;
  onSelect: (key: string) => void;
  onClose: (key: string) => void;
  /** Tab right-click menu entry: close every tab. Omit to hide the menu. */
  onCloseAll?: () => void;
  /** Tab right-click menu entry: close every tab but the one in view. */
  onCloseInactive?: () => void;
  closeLabel: string;
  /** Drag-reorder: dragged tab key dropped before/after a target tab key. */
  onReorder?: (draggedKey: string, targetKey: string, before: boolean) => void;
  /** Invoked by the trailing "+" button; omit to hide it. */
  onNew?: () => void;
  /** Buttons pinned to the strip's right edge, outside the scrolling tabs. */
  actions?: ReactNode;
  /** Node pinned left of the tabs (e.g. a sidebar expand button). */
  leading?: ReactNode;
  /** Reserve the macOS traffic-light inset; turn off while the full-height
   *  sidebar owns the titlebar's left edge. Default true. */
  trafficLightInset?: boolean;
}

/**
 * Conversation tab strip doubling as the window drag region (overlay
 * titlebar). Clicks land on tab elements; only the strip's own padding
 * starts a window drag. Tabs scroll horizontally without a scrollbar and
 * vertical wheel deltas translate to horizontal scroll, like VSCode.
 */
export function SessionTabStrip({
  tabs,
  activeKey,
  onSelect,
  onClose,
  onCloseAll,
  onCloseInactive,
  closeLabel,
  onReorder,
  actions,
  onNew,
  leading,
  trafficLightInset = true,
}: SessionTabStripProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();
  const { dropTarget, suppressClickRef, handleTabPointerDown } =
    useTabDragReorder(onReorder);
  const titlebarStyle = useTitlebarStyle();
  // 左侧红绿灯区：macOS 系统原生红绿灯 或 Windows 仿 mac 自绘按钮。
  const customControls = needsWindowControls(titlebarStyle);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const { handleStripDoubleClick, handleTabListKeyDown } = useTabStripChrome({
    stripRef,
    scrollRef,
    activeKey,
    tabCount: tabs.length,
    customControls,
  });

  return (
    <div
      ref={stripRef}
      data-tauri-drag-region
      onDoubleClick={handleStripDoubleClick}
      className={cx(
        "flex h-10 shrink-0 items-center border-b border-separator-border bg-background-primary-default select-none",
        (IS_MAC || customControls) && trafficLightInset && "pl-[80px]",
      )}
    >
      {customControls && trafficLightInset && (
        <div className="flex h-full shrink-0 items-center pl-3 pr-4">
          <WindowControls />
        </div>
      )}
      {leading && <div className="flex h-full shrink-0 items-center pl-2">{leading}</div>}
      <div
        ref={scrollRef}
        onKeyDown={handleTabListKeyDown}
        className="group scrollbar-none flex min-w-0 flex-1 items-center overflow-x-auto px-2"
      >
      <div role="tablist" aria-label="tabs" className="flex min-w-0 items-center gap-1">
      {tabs.map((tab) => (
        <SessionTab
          key={tab.key}
          tab={tab}
          isActive={tab.key === activeKey}
          dragged={dropTarget?.draggedKey === tab.key}
          dropBefore={dropTarget?.key === tab.key ? dropTarget.before : null}
          closeLabel={closeLabel}
          onShowMenu={onCloseAll || onCloseInactive ? setMenu : undefined}
          onSelect={onSelect}
          onClose={onClose}
          onPointerDown={onReorder ? handleTabPointerDown(tab) : undefined}
          suppressClickRef={suppressClickRef}
        />
      ))}
      </div>
      {onNew && (
        <button
          type="button"
          aria-label={t("chat.newChat")}
          title={t("chat.newChat")}
          onClick={onNew}
          className="ml-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-foreground-icon-tertiary opacity-0 transition-opacity hover:bg-background-secondary-hover hover:text-foreground-icon-primary focus-visible:opacity-100 group-hover:opacity-100"
        >
          <Plus className="size-4" aria-hidden />
        </button>
      )}
      </div>
      {actions && (
        <div className="flex h-full shrink-0 items-center">
          {actions}
        </div>
      )}
      <TabStripContextMenu
        menu={menu}
        onCloseAll={onCloseAll}
        onCloseInactive={onCloseInactive}
        onDismiss={() => setMenu(null)}
      />
    </div>
  );
}
